import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const ALLOWED_SCHEMA = "arco_evm"
const OBJECT_KINDS = new Set(["TABLE", "INDEX", "VIEW", "SEQUENCE", "FUNCTION", "PROCEDURE", "TYPE"])

// A small static guard, not a PostgreSQL parser. Preserve identifiers, ignore
// comments/literals, and also scan dollar-quoted routine bodies.
function tokenize(sql, findings, file, routineBody = false) {
  const tokens = []
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
      tokens.push({ kind: quote === '"' ? "identifier" : "literal", value, routineBody, quoted: quote === '"' })
      continue
    }
    const dollar = sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0]
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length)
      if (end === -1) { findings.push(`${file}: unterminated dollar-quoted body`); break }
      tokens.push(...tokenize(sql.slice(i + dollar.length, end), findings, file, true))
      i = end + dollar.length
      continue
    }
    const identifier = sql.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_$]*/)?.[0]
    if (identifier) {
      tokens.push({ kind: "identifier", value: identifier.toLowerCase(), routineBody })
      i += identifier.length
      continue
    }
    tokens.push({ kind: "punctuation", value: sql[i++], routineBody })
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

/** Inspect complete, lexically ordered migration history without a DB. */
export function inspectMigrationHistory(migrations) {
  const findings = []
  let schemaCreated = false
  if (!migrations.length) findings.push("Migration history is empty")
  for (const { file, sql } of [...migrations].sort((a, b) => a.file.localeCompare(b.file))) {
    const tokens = tokenize(sql, findings, file)
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
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      const current = word(tokens, i)
      if (token.kind === "literal" && ["AS", "DO"].includes(word(tokens, i - 1))) add("single-quoted executable bodies are unsupported; use an inspected dollar-quoted body")
      if (token.kind !== "identifier") continue
      if (token.value.toLowerCase() === "public") add("references public schema or identifier")
      if (token.value.toLowerCase().includes("waitlist")) add("references waitlist identifier")
      if (current === "SEARCH_PATH" || current === "SET_CONFIG") add("search-path changes or set_config are unsupported")
      if (current === "SET" && word(tokens, i + 1) === "SCHEMA") add("SET SCHEMA is unsupported")
      if (current === "U" && tokens[i + 1]?.value === "&") add("Unicode-escaped SQL identifiers and literals are unsupported")
      if (current === "EXECUTE" && !["FUNCTION", "PROCEDURE"].includes(word(tokens, i + 1))) add("dynamic EXECUTE is unsupported by the migration isolation guard")
      // NEW/OLD are trigger row records, not schemas, inside routine bodies.
      if (tokens[i - 1]?.value !== "." && tokens[i + 1]?.value === "." && tokens[i + 2]?.kind === "identifier") {
        const triggerRecord = token.routineBody && ["new", "old"].includes(token.value)
        if (token.value !== ALLOWED_SCHEMA && !triggerRecord) add(`references non-${ALLOWED_SCHEMA} qualifier ${token.value}`)
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
          while (at < tokens.length && tokens[at].value !== ";" && word(tokens, at) !== "ON") at++
          if (word(tokens, at) !== "ON") add(`CREATE ${kind} is missing its ON target`)
          else requireQualified(at + 1, `CREATE ${kind} ON`)
        } else if (OBJECT_KINDS.has(kind)) requireQualified(at, `CREATE ${kind}`)
        else add(`unsupported CREATE object kind ${kind || "(missing)"}`)
      }
      if (current === "ALTER" || current === "DROP") {
        let at = i + 1
        if (word(tokens, at) === "MATERIALIZED") at++
        const kind = word(tokens, at++)
        if (OBJECT_KINDS.has(kind)) {
          let next = requireQualified(at, `${current} ${kind}`)
          if (current === "DROP") while (tokens[next]?.value === ",") next = requireQualified(next + 1, `${current} ${kind}`)
        } else add(`unsupported ${current} object kind ${kind || "(missing)"}`)
      }
      if (current === "TRUNCATE") {
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
