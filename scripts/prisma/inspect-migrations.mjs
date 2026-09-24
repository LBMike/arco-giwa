import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const ALLOWED_SCHEMA = "arco_evm"
const OBJECT_KINDS = new Set(["TABLE", "INDEX", "VIEW", "SEQUENCE", "FUNCTION", "PROCEDURE", "TYPE"])

// A small static guard, not a PostgreSQL parser. Preserve identifiers, ignore
// comments/literals, and also scan dollar-quoted routine bodies.
function tokenize(sql, findings, file, routineDepth = 0, bodies = { next: 1 }, routineId = 0) {
  const tokens = []
  const routineBody = routineDepth > 0
  let i = 0
  while (i < sql.length) {
    if (/\s/.test(sql[i])) { i++; continue }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2)
      i = end === -1 ? sql.length : end + 1
      continue
    }
    if (sql.startsWith("/*", i)) {
      let depth = 1
      i += 2
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) { depth++; i += 2 }
        else if (sql.startsWith("*/", i)) { depth--; i += 2 }
        else i++
      }
      if (depth) findings.push(`${file}: unterminated block comment`)
      continue
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const escapeString = sql[i] === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/[a-zA-Z0-9_$]/.test(sql[i - 2] ?? "")
      const quote = sql[i++]
      let value = ""
      let closed = false
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { value += quote; i += 2; continue }
          i++
          closed = true
          break
        }
        if (escapeString && sql[i] === "\\") {
          value += sql[i + 1] ?? ""
          i += 2
        } else value += sql[i++]
      }
      if (!closed) findings.push(`${file}: unterminated ${quote === '"' ? "identifier" : "string"}`)
      tokens.push({ kind: quote === '"' ? "identifier" : "literal", value, routineBody, routineDepth, routineId, quoted: quote === '"' })
      continue
    }
    const dollar = sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0]
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length)
      if (end === -1) { findings.push(`${file}: unterminated dollar-quoted body`); break }
      tokens.push({ kind: "bodyStart", value: dollar, routineBody, routineDepth, routineId })
      tokens.push(...tokenize(sql.slice(i + dollar.length, end), findings, file, routineDepth + 1, bodies, bodies.next++))
      tokens.push({ kind: "bodyEnd", value: dollar, routineBody, routineDepth, routineId })
      i = end + dollar.length
      continue
    }
    const identifier = sql.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_$]*/)?.[0]
    if (identifier) {
      tokens.push({ kind: "identifier", value: identifier.toLowerCase(), routineBody, routineDepth, routineId })
      i += identifier.length
      continue
    }
    tokens.push({ kind: "punctuation", value: sql[i++], routineBody, routineDepth, routineId })
  }
  return tokens
}

function word(tokens, index) {
  return tokens[index]?.kind === "identifier" && !tokens[index].quoted ? tokens[index].value.toUpperCase() : ""
}

function skipOptions(tokens, index) {
  if (word(tokens, index) === "CONCURRENTLY") index++
  if (word(tokens, index) === "IF") {
    index++
    if (word(tokens, index) === "NOT") index++
    if (word(tokens, index) === "EXISTS") index++
  }
  if (word(tokens, index) === "ONLY") index++
  return index
}

// Exempt token positions, never a global list of qualifier names. This guard
// deliberately supports only simple, qualified SELECT sources and top-level
// %ROWTYPE declarations used by the migrations; it is not a SQL name resolver.
function fieldReferences(tokens) {
  const queries = new Map()
  for (let start = 0; start < tokens.length; start++) {
    if (word(tokens, start) !== "SELECT") continue
    const scope = { alias: null, phases: new Map() }
    const id = tokens[start].routineId
    let depth = 0
    let phase = "expression"
    for (let i = start + 1; i < tokens.length; i++) {
      const token = tokens[i]
      if (token.routineId !== id || (token.kind === "punctuation" && token.value === ";")) break
      if (token.value === ")" && token.kind === "punctuation" && depth === 0) break
      const current = word(tokens, i)
      if (depth === 0 && ["UNION", "INTERSECT", "EXCEPT"].includes(current)) break
      if (depth === 0 && current === "FROM" && word(tokens, i - 1) !== "DISTINCT") {
        phase = "relation"
        // One table, optional AS, then WHERE. JOIN/CTE/derived-table aliases
        // require a separately supported grammar instead of guessed scope.
        let alias = i + 4
        if (word(tokens, alias) === "AS") alias++
        if (tokens[i + 1]?.value === ALLOWED_SCHEMA && tokens[i + 1]?.kind === "identifier"
          && tokens[i + 2]?.value === "." && tokens[i + 3]?.kind === "identifier"
          && tokens[alias]?.kind === "identifier" && word(tokens, alias + 1) === "WHERE") {
          scope.alias = tokens[alias].value
        }
      } else if (depth === 0 && ["WHERE", "HAVING", "GROUP", "ORDER", "LIMIT", "OFFSET", "WINDOW"].includes(current)) {
        phase = "expression"
      }
      // Inner SELECTs are visited later and replace these entries. An outer
      // alias is never silently granted to a nested or sibling SELECT.
      scope.phases.set(i, phase)
      queries.set(i, scope)
      if (token.kind === "punctuation" && token.value === "(") depth++
      else if (token.kind === "punctuation" && token.value === ")") depth--
    }
  }

  const records = new Map()
  const starts = new Map()
  for (let i = 0; i < tokens.length; i++) {
    const id = tokens[i].routineId
    if (id > 0 && !starts.has(id)) starts.set(id, i)
  }
  for (const [id, start] of starts) {
    if (word(tokens, start) !== "DECLARE") continue
    let i = start + 1
    const names = new Set()
    while (tokens[i]?.routineId === id && word(tokens, i) !== "BEGIN") {
      if (tokens[i]?.kind !== "identifier" || tokens[i + 1]?.kind !== "identifier"
        || tokens[i + 1].value !== ALLOWED_SCHEMA || tokens[i + 2]?.value !== "."
        || tokens[i + 3]?.kind !== "identifier" || tokens[i + 4]?.value !== "%"
        || word(tokens, i + 5) !== "ROWTYPE" || tokens[i + 6]?.value !== ";") break
      names.add(tokens[i].value)
      i += 7
    }
    if (word(tokens, i) !== "BEGIN" || tokens[i]?.routineId !== id) continue
    // Nested DECLARE can shadow a record; conservatively decline the exemption.
    if (tokens.slice(i + 1).some(t => t.routineId === id && !t.quoted && t.value === "declare")) continue
    records.set(id, { names, begin: i })
  }

  const allowed = new Set()
  const ddl = new Set()
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.kind === "punctuation" && token.value === ";") ddl.delete(token.routineId)
    if (["CREATE", "ALTER", "DROP"].includes(word(tokens, i))) ddl.add(token.routineId)
    // DDL options can use '=' before a function/type name, e.g. TYPE INPUT=.
    // They are not row expressions; dollar bodies have independent identities.
    if (ddl.has(token.routineId)) continue
    if (token.kind !== "identifier" || tokens[i - 1]?.value === "." || tokens[i + 1]?.value !== "."
      || tokens[i + 2]?.kind !== "identifier") continue
    const query = queries.get(i)
    const record = records.get(token.routineId)
    const known = (query?.alias === token.value)
      || (record && i > record.begin && record.names.has(token.value))
      || (token.routineBody && ["new", "old"].includes(token.value))
    if (!known || query?.phases.get(i) === "relation") continue
    // A function, chained qualifier or type/collation is never a row field.
    if ([".", "(", "%"].includes(tokens[i + 3]?.value)
      || ["literal", "bodyStart"].includes(tokens[i + 3]?.kind)
      || (word(tokens, i + 3) === "E" && tokens[i + 4]?.kind === "literal")) continue
    const previous = word(tokens, i - 1)
    const distinctFrom = previous === "FROM" && word(tokens, i - 2) === "DISTINCT"
      && (word(tokens, i - 3) === "IS" || (word(tokens, i - 3) === "NOT" && word(tokens, i - 4) === "IS"))
    const expressionWord = ["IF", "ELSIF", "WHEN", "THEN", "ELSE", "AND", "OR", "NOT", "RETURN", "SELECT", "WHERE", "HAVING"].includes(previous)
    const punctuation = tokens[i - 1]?.kind === "punctuation" ? tokens[i - 1].value : ""
    const operator = ["=", "<", ">", "!", "+", "-", "*", "/", "|", "&"].includes(punctuation)
    // Parenthesized expressions/argument lists are allowed only with a known
    // expression introducer; FROM (alias.table) and DDL/type lists stay closed.
    let argumentsList = false
    if (["(", ","].includes(punctuation)) {
      let nesting = 0
      for (let at = i - 1; at >= 0 && tokens[at].routineId === token.routineId; at--) {
        if (tokens[at].kind !== "punctuation") continue
        if (tokens[at].value === ";") break
        if (tokens[at].value === ")") nesting++
        if (tokens[at].value !== "(") continue
        if (nesting > 0) { nesting--; continue }
        let before = at - 1
        while (tokens[before]?.value === "(" && tokens[before]?.routineId === token.routineId) before--
        const head = word(tokens, before)
        argumentsList = ["ROW", "COALESCE", "NULLIF", "JSONB_BUILD_OBJECT", "IF", "ELSIF", "WHEN", "NOT", "AND", "OR", "WHERE", "SELECT", "IN"].includes(head)
          || ["=", "<", ">"].includes(tokens[before]?.value)
          || (head === "FROM" && word(tokens, before - 1) === "DISTINCT" &&
            (word(tokens, before - 2) === "IS" || (word(tokens, before - 2) === "NOT" && word(tokens, before - 3) === "IS")))
        break
      }
    }
    if (distinctFrom || expressionWord || operator || argumentsList
      || (punctuation === "," && query?.phases.get(i) === "expression")) allowed.add(i)
  }
  return allowed
}

/** Inspect complete, lexically ordered migration history without a DB. */
export function inspectMigrationHistory(migrations) {
  const findings = []
  let schemaCreated = false
  if (!migrations.length) findings.push("Migration history is empty")
  for (const { file, sql } of [...migrations].sort((a, b) => a.file.localeCompare(b.file))) {
    const tokens = tokenize(sql, findings, file)
    const fields = fieldReferences(tokens)
    const add = (message) => findings.push(`${file}: ${message}`)
    const requireQualified = (index, context) => {
      const start = skipOptions(tokens, index)
      const token = tokens[start]
      if (token?.kind !== "identifier" || tokens[start + 1]?.value !== "." || tokens[start + 2]?.kind !== "identifier") {
        add(`${context} requires an explicit ${ALLOWED_SCHEMA}-qualified object`)
        return start + 1
      }
      if (token.value !== ALLOWED_SCHEMA) add(`${context} references non-${ALLOWED_SCHEMA} schema ${token.value}`)
      if (!schemaCreated) add(`${context} appears before the idempotent ${ALLOWED_SCHEMA} schema bootstrap`)
      return start + 3
    }
    const pendingDoBodies = new Set()
    const truncateTriggerEvents = new Set()
    const alterDropConstraintClauses = new Set()
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      const current = word(tokens, i)
      // Entering a dollar body fulfills any enclosing DO body. At its own
      // depth, DO may place LANGUAGE before or after its quoted body. A prefix
      // E belongs to the following string and must not hide FUNCTION/PROCEDURE AS.
      for (const depth of pendingDoBodies) if (depth < token.routineDepth) pendingDoBodies.delete(depth)
      if (token.kind === "punctuation" && token.value === ";") pendingDoBodies.delete(token.routineDepth)
      if (current === "DO" && !["UPDATE", "NOTHING"].includes(word(tokens, i + 1))) pendingDoBodies.add(token.routineDepth)
      const beforeLiteral = word(tokens, i - 1) === "E" ? i - 2 : i - 1
      if (token.kind === "literal" && (word(tokens, beforeLiteral) === "AS" || pendingDoBodies.has(token.routineDepth))) {
        add("single-quoted executable bodies are unsupported; use an inspected dollar-quoted body")
      }
      if (token.kind !== "identifier") continue
      if (token.value.toLowerCase() === "public") add("references public schema or identifier")
      if (token.value.toLowerCase().includes("waitlist")) add("references waitlist identifier")
      if (current === "SEARCH_PATH" || current === "SET_CONFIG") add("search-path changes or set_config are unsupported")
      if (current === "SET" && word(tokens, i + 1) === "SCHEMA") add("SET SCHEMA is unsupported")
      if (current === "U" && tokens[i + 1]?.value === "&") add("Unicode-escaped SQL identifiers and literals are unsupported")
      if (current === "EXECUTE" && !["FUNCTION", "PROCEDURE"].includes(word(tokens, i + 1))) add("dynamic EXECUTE is unsupported by the migration isolation guard")
      // Only lexically proven expression fields may use a non-schema qualifier.
      if (tokens[i - 1]?.value !== "." && tokens[i + 1]?.value === "." && tokens[i + 2]?.kind === "identifier") {
        if (token.value !== ALLOWED_SCHEMA && !fields.has(i)) add(`references non-${ALLOWED_SCHEMA} qualifier ${token.value}`)
        if (token.value === ALLOWED_SCHEMA && !schemaCreated) add(`references ${ALLOWED_SCHEMA} before its schema bootstrap`)
      }
      if (current === "CREATE") {
        let at = i + 1
        if (word(tokens, at) === "OR" && word(tokens, at + 1) === "REPLACE") at += 2
        if (word(tokens, at) === "UNIQUE" || word(tokens, at) === "CONSTRAINT") at++
        if (word(tokens, at) === "MATERIALIZED") at++
        const kind = word(tokens, at++)
        if (kind === "SCHEMA") {
          const idempotent = word(tokens, at) === "IF" && word(tokens, at + 1) === "NOT" && word(tokens, at + 2) === "EXISTS"
          if (!idempotent) add("CREATE SCHEMA must use IF NOT EXISTS")
          const name = tokens[skipOptions(tokens, at)]
          if (name?.kind !== "identifier" || name.value !== ALLOWED_SCHEMA) add(`CREATE SCHEMA permits only ${ALLOWED_SCHEMA}`)
          else if (idempotent && !token.routineBody) schemaCreated = true
        } else if (kind === "INDEX" || kind === "TRIGGER") {
          // PostgreSQL index/trigger names are unqualified; the table sets schema.
          const declarationStart = at
          while (at < tokens.length && tokens[at].value !== ";" && word(tokens, at) !== "ON") at++
          if (word(tokens, at) !== "ON") add(`CREATE ${kind} is missing its ON target`)
          else {
            requireQualified(at + 1, `CREATE ${kind} ON`)
            if (kind === "TRIGGER") {
              // Exempt only event tokens within this CREATE TRIGGER header,
              // before its ON relation. Later statements/routine bodies retain
              // the normal TRUNCATE target check.
              for (let event = declarationStart; event < at; event++) {
                if (word(tokens, event) === "TRUNCATE" && tokens[event].routineDepth === token.routineDepth &&
                  ["BEFORE", "AFTER", "OR"].includes(word(tokens, event - 1)) &&
                  ["OR", "ON"].includes(word(tokens, event + 1))) truncateTriggerEvents.add(event)
              }
            }
          }
        } else if (OBJECT_KINDS.has(kind)) requireQualified(at, `CREATE ${kind}`)
        else add(`unsupported CREATE object kind ${kind || "(missing)"}`)
      }
      if (current === "ALTER" || (current === "DROP" && !alterDropConstraintClauses.has(i))) {
        let at = i + 1
        if (word(tokens, at) === "MATERIALIZED") at++
        const kind = word(tokens, at++)
        if (OBJECT_KINDS.has(kind)) {
          let next = requireQualified(at, `${current} ${kind}`)
          if (current === "DROP") while (tokens[next]?.value === ",") next = requireQualified(next + 1, `${current} ${kind}`)
          if (current === "ALTER" && kind === "TABLE") {
            // A DROP CONSTRAINT action inherits its already-checked ALTER TABLE
            // target. Exempt only top-level action starts in this one statement,
            // never nested expressions, routine bodies or later statements.
            let nesting = 0
            let actionStart = true
            for (let clause = next; clause < tokens.length && tokens[clause].value !== ";"; clause++) {
              if (tokens[clause].routineDepth !== token.routineDepth) continue
              const value = tokens[clause].value
              if (actionStart && nesting === 0 && word(tokens, clause) === "DROP" && word(tokens, clause + 1) === "CONSTRAINT") alterDropConstraintClauses.add(clause)
              if (value === "(") nesting++
              if (value === ")") nesting--
              actionStart = value === "," && nesting === 0
            }
          }
        } else add(`unsupported ${current} object kind ${kind || "(missing)"}`)
      }
      if (current === "TRUNCATE" && !truncateTriggerEvents.has(i)) {
        let at = i + 1
        if (word(tokens, at) === "TABLE") at++
        let next = requireQualified(at, "TRUNCATE")
        while (tokens[next]?.value === ",") next = requireQualified(next + 1, "TRUNCATE")
      }
      if ((current === "INSERT" || current === "MERGE") && word(tokens, i + 1) === "INTO") {
        requireQualified(i + 2, `${current} INTO`)
      }
      if (current === "DELETE" && word(tokens, i + 1) === "FROM") requireQualified(i + 2, "DELETE FROM")
      if (current === "UPDATE") {
        const previous = word(tokens, i - 1)
        const next = word(tokens, i + 1)
        // UPDATE also names trigger events, FK actions, row locks, and the
        // ON CONFLICT action; none introduces a new relation write target.
        const nonTargetUse = ["ON", "OF", "OR"].includes(next) || ["ON", "FOR"].includes(previous) ||
          (previous === "KEY" && word(tokens, i - 2) === "NO" && word(tokens, i - 3) === "FOR") ||
          (["DO", "THEN"].includes(previous) && next === "SET")
        if (!nonTargetUse) requireQualified(i + 1, "UPDATE")
      }
      if (current === "REFERENCES" || current === "INHERITS") requireQualified(i + (tokens[i + 1]?.value === "(" ? 2 : 1), current)
    }
  }
  if (!schemaCreated) findings.push(`Migration history must bootstrap ${ALLOWED_SCHEMA} with CREATE SCHEMA IF NOT EXISTS`)
  return [...new Set(findings)]
}

export function inspectMigrationsDirectory(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) return [`No migrations directory found: ${migrationsDir}`]
  const migrations = []
  for (const dirent of fs.readdirSync(migrationsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const file = path.join(migrationsDir, dirent.name, "migration.sql")
    if (!fs.existsSync(file)) return [`Missing migration.sql in ${path.join(migrationsDir, dirent.name)}`]
    migrations.push({ file, sql: fs.readFileSync(file, "utf8") })
  }
  return inspectMigrationHistory(migrations)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const findings = inspectMigrationsDirectory(path.join(process.cwd(), "prisma", "migrations"))
  if (findings.length) {
    console.error(findings.join("\n"))
    process.exitCode = 1
  } else console.log("Prisma migration SQL inspection passed")
}
