/**
 * Checks the ODS response handling. No network: the payloads are recorded
 * shapes from the ORD API.
 *
 *   npm run test:ods
 */
import assert from 'node:assert/strict';
import { mapWithConcurrency, parseOrganisation } from '../lib/ods.ts';

const checks: Array<[string, () => void | Promise<void>]> = [
  [
    'flattens the ORD address and keeps the postcode separate',
    () => {
      const provider = parseOrganisation('R1H', {
        Organisation: {
          Name: 'BARTS HEALTH NHS TRUST',
          Status: 'Active',
          GeoLoc: {
            Location: {
              AddrLn1: 'THE ROYAL LONDON HOSPITAL',
              AddrLn2: '80 NEWARK STREET',
              Town: 'LONDON',
              PostCode: 'E1 2ES',
              Country: 'ENGLAND',
            },
          },
        },
      });
      assert.equal(provider.address, 'THE ROYAL LONDON HOSPITAL, 80 NEWARK STREET, LONDON');
      assert.equal(provider.postcode, 'E1 2ES');
      assert.equal(provider.name, 'BARTS HEALTH NHS TRUST');
      assert.equal(provider.status, 'Active');
    },
  ],
  [
    'skips missing address lines rather than leaving empty segments',
    () => {
      const provider = parseOrganisation('X1', {
        Organisation: {
          Name: 'SOMEWHERE',
          GeoLoc: { Location: { AddrLn1: 'UNIT 1', Town: 'YORK', County: 'NORTH YORKSHIRE', PostCode: 'yo26 6rs' } },
        },
      });
      assert.equal(provider.address, 'UNIT 1, YORK, NORTH YORKSHIRE');
      assert.equal(provider.postcode, 'YO26 6RS', 'postcodes are upper-cased for lookup');
    },
  ],
  [
    'a record with no location yields nulls, not empty strings',
    () => {
      const provider = parseOrganisation('X2', { Organisation: { Name: 'NO ADDRESS' } });
      assert.equal(provider.address, null);
      assert.equal(provider.postcode, null);
      assert.equal(provider.country, null);
    },
  ],
  [
    'concurrency preserves input order',
    async () => {
      const items = [10, 5, 1, 8, 3];
      const out = await mapWithConcurrency(items, 2, async (value) => {
        await new Promise((resolve) => setTimeout(resolve, value));
        return value * 2;
      });
      assert.deepEqual(out, [20, 10, 2, 16, 6]);
    },
  ],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    await check();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error instanceof Error ? error.message : error}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exitCode = 1;
