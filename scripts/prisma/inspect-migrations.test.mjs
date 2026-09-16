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
