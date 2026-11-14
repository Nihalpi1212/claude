// Generates the fixture PDFs before the e2e run.
import { makeAll } from '../fixtures/make-fixtures.mjs';

export default async function globalSetup() {
  await makeAll();
}
