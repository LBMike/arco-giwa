// TEST ONLY: fresh-process locale probe. No database, network or environment secrets.
import assert from 'node:assert/strict';
import { canonicalJson, manifestDigest, callDigest, type Manifest, type AuthorizedCall } from './contracts.js';
import { digest, deriveOrder } from '../stocks-submissions/contracts.js';
import { orderBinding } from '../stocks-submissions/enrollment.js';
import { canonicalLocaleVectors } from './canonical-locale-fixtures.js';

function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed); // Array order is semantic, never sorted.
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([k,v]) => [k,reversed(v)]));
  return value;
}
const values = new Map(canonicalLocaleVectors.map(v => [v.name,v]));
const failures: string[] = [];
const verify = (name: string, run: () => void) => { try { run(); } catch { failures.push(name); } };
for (const vector of canonicalLocaleVectors) {
  verify(`${vector.name}:canonical`, () => assert.equal(canonicalJson(vector.value), vector.canonical));
  verify(`${vector.name}:digest`, () => assert.equal(digest(vector.value), vector.digest));
  // JSONB does not preserve insertion order. Simulate a deserialized reordered row recursively.
  const reordered = JSON.parse(JSON.stringify(reversed(vector.value)));
  verify(`${vector.name}:reordered`, () => { assert.equal(canonicalJson(reordered), vector.canonical); assert.equal(digest(reordered), vector.digest); });
}
const manifest = values.get('manifest')!.value as Manifest;
verify('manifestDigest:entrypoint', () => assert.equal(manifestDigest(manifest), values.get('manifest')!.digest));
verify('callDigest:entrypoint', () => assert.equal(callDigest(values.get('authorizedCall')!.value as AuthorizedCall), values.get('authorizedCall')!.digest));
const binding = values.get('orderBinding')!.value as Record<string,any>;
const order = { ...binding, id: binding.orderId };
verify('orderBinding:entrypoint', () => assert.equal(orderBinding(order,'BUY'), values.get('orderBinding')!.digest));
const derived = deriveOrder(manifest, order, 'BUY');
verify('deriveOrder:approval', () => assert.equal(digest(derived.approval), values.get('approvalTransaction')!.digest));
verify('deriveOrder:transfer', () => assert.equal(digest(derived.transfer), values.get('transferTransaction')!.digest));
verify('deriveOrder:physicalIntent', () => assert.equal(derived.intentKey, values.get('intentArray')!.digest));
console.log(JSON.stringify({locale:Intl.Collator().resolvedOptions().locale,node:process.version,icu:process.versions.icu,vectorCount:canonicalLocaleVectors.length,failures}));
if (failures.length) process.exitCode = 1;
