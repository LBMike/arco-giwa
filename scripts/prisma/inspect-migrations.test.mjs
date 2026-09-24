import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { inspectMigrationHistory, inspectMigrationsDirectory } from "./inspect-migrations.mjs"

const bootstrap = { file: "001_init/migration.sql", sql: 'CREATE SCHEMA IF NOT EXISTS "arco_evm";' }
const inspect = (sql) => inspectMigrationHistory([bootstrap, { file: "002_next/migration.sql", sql }])

test("bootstrap once permits additive migrations in sorted history", () => {
  assert.deepEqual(inspectMigrationHistory([
    { file: "003_column/migration.sql", sql: 'ALTER TABLE "arco_evm"."Order" ADD COLUMN "note" TEXT;' },
    { file: "002_table/migration.sql", sql: 'CREATE TABLE "arco_evm"."Order" (id TEXT);' },
    bootstrap,
  ]), [])
})

test("actual committed migration history passes without changing SQL", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  assert.deepEqual(inspectMigrationsDirectory(path.join(root, "prisma/migrations")), [])
})

test("bootstrap is required before use and must be idempotent", () => {
  assert.match(inspectMigrationHistory([{ file: "001.sql", sql: 'CREATE TABLE "arco_evm"."Thing" (id TEXT);' }]).join("\n"), /bootstrap/)
  assert.match(inspectMigrationHistory([{ file: "001.sql", sql: 'CREATE SCHEMA "arco_evm";' }]).join("\n"), /IF NOT EXISTS/)
  assert.match(inspectMigrationHistory([
    { file: "000_table.sql", sql: "CREATE TABLE arco_evm.thing (id TEXT);" }, bootstrap,
  ]).join("\n"), /before/)
})

test("comments and strings do not create or reference schemas", () => {
  assert.deepEqual(inspect(`
    -- public.waitlist and CREATE TABLE other.bad are documentation only.
    /* nested /* public.waitlist */ comment */
    CREATE TABLE arco_evm.note (description TEXT DEFAULT 'public.waitlist');
  `), [])
  assert.match(inspectMigrationHistory([{ file: "001.sql", sql: '-- CREATE SCHEMA IF NOT EXISTS "arco_evm";' }]).join("\n"), /bootstrap/)
})

test("literal escaping and quoted keyword identifiers cannot hide executable SQL", () => {
  assert.deepEqual(inspect('CREATE TABLE arco_evm.thing ("create" TEXT, "references" TEXT);'), [])
  assert.match(inspect(String.raw`SELECT 'backslash\'; CREATE TABLE public.bad (id TEXT);`).join("\n"), /public/)
  assert.deepEqual(inspect(String.raw`SELECT E'escaped\' public.waitlist';`), [])
  assert.match(inspect(String.raw`CREATE TABLE U&"arco\005fevm".thing (id TEXT);`).join("\n"), /unsupported|qualified/)
})

test("quoted and unquoted public/foreign schemas are rejected", () => {
  for (const schema of ['"public"', "public", '"other"', "other"]) {
    assert.match(inspect(`CREATE TABLE ${schema}.thing (id TEXT);`).join("\n"), /public|non-arco_evm/)
    assert.match(inspect(`ALTER TABLE ${schema}.thing ADD COLUMN value TEXT;`).join("\n"), /public|non-arco_evm/)
  }
  assert.match(inspect('CREATE SCHEMA IF NOT EXISTS "other";').join("\n"), /only arco_evm/)
  assert.match(inspect('CREATE TABLE "ARCO_EVM".thing (id TEXT);').join("\n"), /non-arco_evm/)
})

test("waitlist identifiers, including legacy compound table names, are rejected", () => {
  assert.match(inspect('CREATE TABLE "arco_evm"."Waitlist" (id TEXT);').join("\n"), /waitlist/)
  assert.match(inspect("CREATE TABLE arco_evm.old_waitlist (id TEXT);").join("\n"), /waitlist/)
})

test("unqualified DDL targets and references fail closed", () => {
  for (const sql of [
    "CREATE TABLE thing (id TEXT);", "ALTER TABLE thing ADD COLUMN id TEXT;",
    "DROP TABLE thing;", "CREATE VIEW thing AS SELECT 1;",
    "CREATE TABLE arco_evm.thing (parent TEXT REFERENCES parent(id));",
    "CREATE INDEX thing_idx ON thing(id);", "TRUNCATE arco_evm.thing, other;",
    "DROP TABLE arco_evm.thing, other;",
  ]) assert.match(inspect(sql).join("\n"), /qualified object/, sql)
})

test("qualified indexes, constraints, and additive DDL are accepted", () => {
  assert.deepEqual(inspect(`
    CREATE TABLE IF NOT EXISTS arco_evm.child (id TEXT REFERENCES arco_evm.parent(id));
    CREATE UNIQUE INDEX IF NOT EXISTS child_idx ON arco_evm.child(id);
    ALTER TABLE ONLY arco_evm.child ADD COLUMN note TEXT;
    DROP INDEX IF EXISTS arco_evm.child_idx;
  `), [])
})

test("write DML targets require explicit schema qualification, including routines", () => {
  for (const target of ["thing", "other.thing", '"public"."thing"']) {
    for (const sql of [
      `INSERT INTO ${target} (id) VALUES ('id');`,
      `UPDATE ${target} SET id = 'id';`,
      `DELETE FROM ${target};`,
      `MERGE INTO ${target} USING arco_evm.source ON true WHEN MATCHED THEN DELETE;`,
    ]) {
      assert.match(inspect(sql).join("\n"), /qualified object|non-arco_evm|public/, sql)
      assert.match(inspect(`CREATE FUNCTION arco_evm.bad() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${sql} END; $$;`).join("\n"), /qualified object|non-arco_evm|public/, sql)
    }
  }
})

test("qualified writes and non-target UPDATE keywords remain valid", () => {
  assert.deepEqual(inspect(`
    INSERT INTO arco_evm.thing (id) VALUES ('id') ON CONFLICT (id) DO UPDATE SET id = 'id';
    UPDATE ONLY arco_evm.thing SET id = 'id';
    DELETE FROM ONLY arco_evm.thing;
    MERGE INTO arco_evm.thing USING arco_evm.source ON true WHEN MATCHED THEN DELETE;
    MERGE INTO arco_evm.thing USING arco_evm.source ON true WHEN MATCHED THEN UPDATE SET id = 'id';
    SELECT id FROM arco_evm.thing FOR UPDATE;
    SELECT id FROM arco_evm.thing FOR NO KEY UPDATE;
    CREATE TABLE arco_evm.child (id TEXT REFERENCES arco_evm.thing(id) ON UPDATE CASCADE);
    CREATE TRIGGER audit BEFORE INSERT OR UPDATE OF id OR DELETE ON arco_evm.thing FOR EACH ROW EXECUTE FUNCTION arco_evm.audit();
  `), [])
})

test("CREATE TRIGGER permits BEFORE TRUNCATE as an event", () => {
  assert.deepEqual(inspect('CREATE TRIGGER "immutable" BEFORE TRUNCATE ON arco_evm."Journal" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm.reject_mutation();'), [])
})

test("CREATE TRIGGER permits TRUNCATE in a combined event list", () => {
  assert.deepEqual(inspect('CREATE TRIGGER "immutable" BEFORE UPDATE OR DELETE OR TRUNCATE ON arco_evm."Journal" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm.reject_mutation();'), [])
})

test("TRUNCATE statements still require safe qualified targets outside trigger events", () => {
  const trigger = 'CREATE TRIGGER "immutable" BEFORE TRUNCATE ON arco_evm."Journal" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm.reject_mutation();'
  for (const target of ["thing", "other.thing", '"public"."thing"']) {
    for (const prefix of ["TRUNCATE", "TRUNCATE TABLE"]) {
      const statement = `${prefix} ${target};`
      for (const sql of [
        statement,
        `${trigger} ${statement}`,
        `DO $$ BEGIN ${statement} END; $$;`,
        `CREATE FUNCTION arco_evm.bad() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${statement} END; $$;`,
      ]) assert.match(inspect(sql).join("\n"), /qualified object|non-arco_evm|public/, sql)
    }
  }
  assert.match(inspect('CREATE TRIGGER immutable BEFORE TRUNCATE ON thing FOR EACH STATEMENT EXECUTE FUNCTION arco_evm.reject_mutation();').join("\n"), /CREATE TRIGGER ON requires/)
})

test("routine bodies are scanned and trigger row fields are not schemas", () => {
  assert.deepEqual(inspect(`
    CREATE FUNCTION arco_evm.reject_update() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN IF NEW.amount <> OLD.amount THEN RAISE EXCEPTION 'immutable'; END IF; RETURN NEW; END;
    $body$;
    CREATE TRIGGER immutable BEFORE UPDATE ON arco_evm.thing FOR EACH ROW EXECUTE FUNCTION arco_evm.reject_update();
  `), [])
  assert.match(inspect(`CREATE FUNCTION arco_evm.bad() RETURNS void LANGUAGE plpgsql AS $$
    BEGIN DELETE FROM public.waitlist; END; $$;`).join("\n"), /public|waitlist/)
  assert.match(inspect(`CREATE FUNCTION arco_evm.bad() RETURNS void LANGUAGE plpgsql AS $$
    BEGIN EXECUTE 'DROP TABLE public.waitlist'; END; $$;`).join("\n"), /dynamic EXECUTE/)
  assert.match(inspect("CREATE FUNCTION arco_evm.bad() RETURNS void LANGUAGE sql AS 'DELETE FROM public.waitlist';").join("\n"), /single-quoted executable/)
})

for (const [name, sql] of [
  ["DO LANGUAGE before a string body", "DO LANGUAGE plpgsql 'BEGIN DELETE FROM public.waitlist; END';"],
  ["DO with an E-string body", "DO E'BEGIN DELETE FROM public.waitlist; END';"],
  ["FUNCTION with an E-string body", "CREATE FUNCTION arco_evm.bad() RETURNS void LANGUAGE sql AS E'DELETE FROM public.waitlist';"],
  ["PROCEDURE with LANGUAGE after an E-string body", "CREATE PROCEDURE arco_evm.bad() AS E'DELETE FROM public.waitlist' LANGUAGE sql;"],
  ["DO LANGUAGE before an E-string body", "DO LANGUAGE plpgsql E'BEGIN DELETE FROM public.waitlist; END';"],
]) {
  test(`rejects single-quoted executable bodies: ${name}`, () => {
    assert.match(inspect(sql).join("\n"), /single-quoted executable/)
  })
}

test("benign E-string defaults remain permitted outside executable body syntax", () => {
  assert.deepEqual(inspect("CREATE TABLE arco_evm.note (note TEXT DEFAULT E'public.waitlist');"), [])
  assert.deepEqual(inspect(`
    DO LANGUAGE plpgsql $$ BEGIN RAISE NOTICE 'ordinary message'; END $$;
    CREATE TABLE arco_evm.note (note TEXT DEFAULT E'public.waitlist');
  `), [])
})

test("search-path and unsupported object changes fail closed", () => {
  for (const sql of ["SET search_path = arco_evm;", "SELECT set_config('search_path', 'public', false);", "CREATE EXTENSION whatever;", "DROP SCHEMA arco_evm;", "ALTER TABLE arco_evm.thing SET SCHEMA other;"]) {
    assert.match(inspect(sql).join("\n"), /unsupported/)
  }
})

test("incomplete SQL tokens fail closed", () => {
  for (const sql of ["/* incomplete", "SELECT 'incomplete", 'SELECT "incomplete', "DO $$ incomplete"]) {
    assert.match(inspect(sql).join("\n"), /unterminated/)
  }
})

test("missing, empty, or incomplete migration directories fail closed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "giwa-migration-inspector-"))
  try {
    assert.match(inspectMigrationsDirectory(path.join(directory, "missing")).join("\n"), /No migrations directory/)
    assert.match(inspectMigrationsDirectory(directory).join("\n"), /empty/)
    fs.mkdirSync(path.join(directory, "001"))
    assert.match(inspectMigrationsDirectory(directory).join("\n"), /Missing migration.sql/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test("qualified ALTER TABLE DROP CONSTRAINT is a clause, not a standalone DROP target", () => {
  assert.deepEqual(inspect('ALTER TABLE arco_evm.thing DROP CONSTRAINT thing_check;'), [])
  assert.deepEqual(inspect('ALTER TABLE ONLY arco_evm.thing ADD COLUMN note TEXT, DROP CONSTRAINT IF EXISTS thing_check;'), [])
  assert.deepEqual(inspect('DO $$ BEGIN ALTER TABLE arco_evm.thing DROP CONSTRAINT thing_check; END; $$;'), [])
})

test("DROP CONSTRAINT exemption cannot hide other targets or escape ALTER statement context", () => {
  for (const sql of [
    'DROP CONSTRAINT thing_check;',
    'ALTER TABLE thing DROP CONSTRAINT thing_check;',
    'ALTER TABLE other.thing DROP CONSTRAINT thing_check;',
    'ALTER TABLE arco_evm.thing DROP CONSTRAINT thing_check; DROP TABLE thing;',
    'ALTER TABLE arco_evm.thing DROP CONSTRAINT thing_check; DO $$ BEGIN DROP TABLE other.thing; END; $$;',
    'DO $$ BEGIN ALTER TABLE arco_evm.thing DROP CONSTRAINT thing_check; DROP TABLE other.thing; END; $$;',
  ]) assert.ok(inspect(sql).length > 0, sql)
})

test("simple qualified SELECT aliases are fields within their own query, with quoted case preserved", () => {
  for (const alias of ['p', 's', '"Proof"']) {
    assert.deepEqual(inspect(`SELECT ${alias}.id FROM arco_evm.proof AS ${alias} WHERE ${alias}.id='id';`), [])
    assert.deepEqual(inspect(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM arco_evm.proof ${alias} WHERE ${alias}.id=NEW.id AND ${alias}.status=NEW.status) THEN RETURN NEW; END IF; END $$;`), [])
  }
  assert.ok(inspect('SELECT proof.id FROM arco_evm.proof "Proof" WHERE proof.id=1;').length > 0)
})

test("a SELECT alias cannot escape to another statement, SELECT branch or routine", () => {
  for (const sql of [
    'SELECT 1 FROM arco_evm.proof p WHERE p.id=1; SELECT p.id;',
    'SELECT 1 FROM arco_evm.proof p WHERE p.id=1 UNION SELECT p.id;',
    'SELECT 1 FROM arco_evm.proof p WHERE p.id=1 INTERSECT SELECT p.id;',
    'SELECT 1 FROM arco_evm.proof p WHERE p.id=1 EXCEPT SELECT p.id;',
    'SELECT (SELECT p.id) FROM arco_evm.proof p WHERE p.id=1;',
    'SELECT (SELECT 1 FROM arco_evm.proof p WHERE p.id=1), p.id;',
    'DO $$ BEGIN SELECT 1 FROM arco_evm.proof p WHERE p.id=1; END $$; DO $$ BEGIN SELECT p.id; END $$;',
  ]) assert.match(inspect(sql).join('\n'), /non-arco_evm qualifier p/, sql)
})

test("alias spelling never authorizes a foreign relation, callable, type or chained qualifier", () => {
  for (const alias of ['p', '"Proof"']) {
    for (const expression of [
      `${alias}.fn()`, `${alias}.table_name.id`, `1::${alias}.domain`,
      `CAST(1 AS ${alias}.domain)`, `'x' COLLATE ${alias}.collation`,
      `(SELECT 1 FROM ${alias}.secret)`, `(SELECT 1 FROM arco_evm.proof, ${alias}.secret)`,
      `(SELECT 1 FROM arco_evm.proof JOIN ${alias}.secret ON true)`,
      `(SELECT 1 FROM (${alias}.secret CROSS JOIN arco_evm.proof))`,
    ]) assert.ok(inspect(`SELECT 1 FROM arco_evm.proof ${alias} WHERE ${expression} IS NOT NULL;`).length > 0, expression)
    assert.ok(inspect(`SELECT 1 FROM ${alias}.proof ${alias} WHERE ${alias}.id=1;`).length > 0)
  }
})

const recordRoutine = (body, name = 'saved') => `CREATE FUNCTION arco_evm.check_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ${name} arco_evm.proof%ROWTYPE;
BEGIN ${body} RETURN NEW; END $$;`

test("qualified ROWTYPE records work only in their declared routine", () => {
  assert.deepEqual(inspect(recordRoutine('SELECT * INTO saved FROM arco_evm.proof; IF saved.id<>NEW.id OR NEW.status IS DISTINCT FROM saved.status THEN RETURN OLD; END IF;')), [])
  assert.deepEqual(inspect(recordRoutine('IF "Saved".id<>NEW.id THEN RETURN OLD; END IF;', '"Saved"')), [])
  for (const sql of [
    recordRoutine('IF saved.id<>NEW.id THEN RETURN OLD; END IF;') + 'SELECT saved.id;',
    recordRoutine('') + 'CREATE FUNCTION arco_evm.other() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF saved.id=1 THEN RETURN NEW; END IF; END $$;',
    recordRoutine('DO $inner$ BEGIN SELECT saved.id; END $inner$;'),
    recordRoutine('DECLARE saved record; BEGIN SELECT saved.id; END;'),
    recordRoutine('IF saved.id<>NEW.id THEN RETURN OLD; END IF;', '"Saved"'),
    'CREATE FUNCTION arco_evm.other() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE saved foreign_schema.proof%ROWTYPE; BEGIN SELECT saved.id; END $$;',
  ]) assert.ok(inspect(sql).length > 0, sql)
})

test("records including NEW/OLD cannot disguise foreign schema object access", () => {
  for (const name of ['saved', 'NEW', 'OLD']) {
    for (const sql of [
      `SELECT ${name}.fn();`, `SELECT ${name}.proof.id;`, `SELECT 1::${name}.domain;`,
      `SELECT CAST(1 AS ${name}.domain);`, `SELECT 'x' COLLATE ${name}.collation;`,
      `SELECT * FROM ${name}.proof;`, `SELECT * FROM arco_evm.proof, ${name}.proof;`,
      `SELECT * FROM arco_evm.proof JOIN ${name}.proof ON true;`,
      `UPDATE arco_evm.proof SET id=1 FROM arco_evm.proof, ${name}.other;`,
      `CREATE TABLE arco_evm.bad (id ${name}.domain);`,
      `DELETE FROM ${name}.proof;`, `INSERT INTO ${name}.proof VALUES (1);`,
      `UPDATE ${name}.proof SET id=1;`,
    ]) assert.ok(inspect(recordRoutine(sql)).length > 0, sql)
  }
})

test("public and waitlist names are still rejected even when declared as aliases or records", () => {
  for (const name of ['public', 'waitlist_record', '"Public"']) {
    assert.ok(inspect(`SELECT 1 FROM arco_evm.proof ${name} WHERE ${name}.id=1;`).length > 0)
    assert.ok(inspect(recordRoutine(`IF ${name}.id=1 THEN RETURN NEW; END IF;`, name)).length > 0)
  }
})

test("Postgres typed-string constants cannot use an alias/record to name a foreign input type", () => {
  for (const literal of ["'x'", "E'x'", '$value$x$value$', '$empty$$empty$']) {
    assert.ok(inspect(`SELECT p.domain ${literal} FROM arco_evm.proof p WHERE true;`).length > 0, literal)
    for (const name of ['saved', 'NEW', 'OLD'])
      assert.ok(inspect(recordRoutine(`SELECT ${name}.domain ${literal};`)).length > 0, name + literal)
  }
})

test("DDL option values cannot be disguised as declared row fields", () => {
  for (const sql of [
    'CREATE TYPE arco_evm.custom (INPUT=saved.read, OUTPUT=saved.write);',
    'CREATE TYPE arco_evm.custom AS RANGE (SUBTYPE=saved.domain);',
    'ALTER TYPE arco_evm.custom SET (RECEIVE=saved.receive);',
    'CREATE TYPE arco_evm.custom (INPUT=NEW.read, OUTPUT=OLD.write);',
  ]) assert.ok(inspect(recordRoutine(sql)).length > 0, sql)
  // A top-level CREATE FUNCTION must not suppress fields inside its body.
  assert.deepEqual(inspect(recordRoutine('IF saved.id=NEW.id THEN RETURN NEW; END IF;')), [])
})
