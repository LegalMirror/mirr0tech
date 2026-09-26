import test from 'node:test';
import assert from 'node:assert/strict';
import { VenueService } from '../src/venues.js';

test('after a receipt the service waits until the RPC has reached that block', async () => {
  let head = 10;
  const provider = { getBlockNumber: async () => head++ };
  const venues = new VenueService({ provider, signer: {}, record: { chainId: 11155111 } });
  assert.equal(await venues.settled(12, { delayMs: 1 }), true, 'catches up within a few polls');
  head = 0;
  assert.equal(await venues.settled(100, { attempts: 3, delayMs: 1 }), false, 'gives up after the attempts');
});
