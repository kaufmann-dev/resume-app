import assert from 'node:assert/strict';
import test from 'node:test';
import { withInferredApplicationType } from '../oauth-registration.js';

test('loopback-only registrations without a type become native clients', () => {
  for (const uris of [['http://localhost:3000/callback'], ['http://127.0.0.1:8080/cb', 'http://[::1]:9000/cb']]) {
    assert.equal(withInferredApplicationType({ redirect_uris: uris }).application_type, 'native');
  }
});

test('explicit types and other redirect lists are left to normal validation', () => {
  const cases = [
    { application_type: 'web', redirect_uris: ['http://localhost:3000/callback'] },
    { redirect_uris: ['https://localhost/callback'] },
    { redirect_uris: ['http://localhost:3000/callback', 'https://app.example/callback'] },
    { redirect_uris: ['http://localhost.example/callback'] },
    { redirect_uris: ['not a url'] },
    { redirect_uris: [] },
    { redirect_uris: 'http://localhost:3000/callback' },
    {}
  ];
  for (const body of cases) assert.deepEqual(withInferredApplicationType(body), body);
});
