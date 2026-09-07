import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop } from './helpers.js';
import {
  all, get, run, exec, transaction, insert, setDriver, activeDriver, inList,
} from '../src/db/index.js';
import { nodeDriver } from '../src/db/driver.node.js';

before(start);
after(stop);

/**
 * The storage engine is swappable so the server can run on a Durable Object,
 * where SQLite is synchronous but reached through a different object. That is
 * only true while every read and write goes through the driver -- one helper
 * reaching for `node:sqlite` directly would work fine here and fail there,
 * silently, until deployed.
 */
describe('the database driver seam', () => {
  it('routes every primitive through the installed driver', () => {
    const seen = [];
    const recording = {
      name: 'recording',
      open: () => nodeDriver.open(),
      isOpen: () => nodeDriver.isOpen(),
      handle: () => nodeDriver.handle(),
      all(sql, params) { seen.push(['all', sql]); return nodeDriver.all(sql, params); },
      get(sql, params) { seen.push(['get', sql]); return nodeDriver.get(sql, params); },
      run(sql, params) { seen.push(['run', sql]); return nodeDriver.run(sql, params); },
      exec(sql) { seen.push(['exec', sql]); return nodeDriver.exec(sql); },
      transaction(fn) { seen.push(['transaction', '']); return nodeDriver.transaction(fn); },
      close() { /* the real driver stays open for the rest of the suite */ },
    };

    const previous = activeDriver();
    try {
      setDriver(recording);
      assert.equal(activeDriver().name, 'recording');

      get('SELECT 1 AS one');
      all('SELECT id FROM organizations LIMIT 1');
      transaction(() => { run("UPDATE organizations SET updated_at = updated_at WHERE 1 = 0"); });

      const verbs = seen.map(([verb]) => verb);
      for (const verb of ['get', 'all', 'run', 'transaction']) {
        assert.ok(verbs.includes(verb), `${verb}() bypassed the driver; verbs seen: ${verbs.join(', ')}`);
      }
    } finally {
      setDriver(previous);
    }
    assert.equal(activeDriver().name, 'node:sqlite', 'the real driver was not restored');
  });

  it('keeps the coercion and JSON handling above the driver, not inside it', () => {
    // A driver receives already-coerced parameters, so a second implementation
    // does not have to reimplement any of this.
    const captured = [];
    const previous = activeDriver();
    try {
      setDriver({
        ...nodeDriver,
        name: 'capturing',
        run(sql, params) { captured.push(params); return nodeDriver.run(sql, params); },
        close() {},
      });
      insert('organizations', {
        id: 'org_seam', name: 'Seam', slug: 'seam-test', plan: 'free', seats: 1,
        settings: { nested: true },
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      });
    } finally {
      setDriver(previous);
    }

    const params = captured.at(-1);
    assert.ok(params, 'insert() did not reach the driver');
    assert.ok(
      params.every((value) => value === null || ['string', 'number', 'bigint'].includes(typeof value)
        || Buffer.isBuffer(value)),
      `a driver should only ever see bindable values, got ${JSON.stringify(params)}`,
    );
    assert.ok(params.includes('{"nested":true}'), 'an object parameter should arrive as JSON text');
    assert.ok(params.includes('2026-01-01T00:00:00.000Z'), 'a Date parameter should arrive as an ISO string');

    run('DELETE FROM organizations WHERE id = ?', ['org_seam']);
  });

  it('reports a dangling foreign key as a client error on any engine', () => {
    // The translation lives above the driver, so both engines get it.
    assert.throws(
      () => insert('leads', {
        id: 'lead_seam', organization_id: 'org_does_not_exist', first_name: 'X',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }),
      (error) => error.status === 400 && /does not exist/i.test(error.message),
    );
  });

  it('leaves no helper talking to node:sqlite behind the driver\'s back', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../src/db/', import.meta.url);
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith('.js') && file !== 'driver.node.js')
      .filter((file) => /from 'node:sqlite'|DatabaseSync/.test(readFileSync(new URL(file, dir), 'utf8')));
    assert.deepEqual(offenders, [],
      `these reach for node:sqlite directly instead of going through a driver: ${offenders.join(', ')}`);
  });
});

describe('the bound-parameter ceiling', () => {
  /**
   * The hosted SQLite engines cap a statement at 100 bound parameters. Building
   * `column IN (?, ?, ?)` spends one per element, so a query scoped to the
   * people a manager can see broke at around 97 of them -- and the notification
   * batch endpoint allows 200 ids outright. Nothing here fails on Node, where
   * the limit is 999, which is exactly why it needs a test.
   */
  it('spends one parameter on a list of any length', () => {
    for (const size of [1, 50, 200, 1000]) {
      const values = Array.from({ length: size }, (_, i) => `id_${i}`);
      const { sql, params } = inList('owner_id', values);
      assert.equal(params.length, 1, `${size} values bound ${params.length} parameters`);
      assert.ok(!sql.includes('?,'), `the clause still expands placeholders: ${sql.slice(0, 60)}`);
    }
  });

  it('matches exactly the listed rows, and nothing for an empty list', () => {
    const orgs = all('SELECT id FROM organizations LIMIT 1').map((row) => row.id);
    const wanted = inList('id', orgs);
    assert.equal(
      all(`SELECT id FROM organizations WHERE ${wanted.sql}`, wanted.params).length,
      orgs.length,
    );

    const none = inList('id', []);
    assert.equal(all(`SELECT id FROM organizations WHERE ${none.sql}`, none.params).length, 0,
      'an empty list must match nothing rather than everything');

    // Duplicates must not change the result.
    const dupes = inList('id', [...orgs, ...orgs]);
    assert.equal(all(`SELECT id FROM organizations WHERE ${dupes.sql}`, dupes.params).length, orgs.length);
  });

  it('leaves no query building placeholders one per value', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const root = new URL('../src/', import.meta.url);
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const url = new URL(entry, dir);
        if (statSync(url).isDirectory()) { walk(new URL(`${entry}/`, dir)); continue; }
        if (!entry.endsWith('.js')) continue;
        const text = readFileSync(url, 'utf8');
        // The INSERT builders are the one legitimate case: a VALUES list cannot
        // use json_each, and its length is the column count, capped well under
        // the ceiling by the schema (36 at its widest).
        for (const line of text.split('\n')) {
          if (line.includes("map(() => '?')") && !line.includes('INSERT INTO')) {
            offenders.push(`${url.pathname.split('/src/')[1]}: ${line.trim().slice(0, 80)}`);
          }
        }
      }
    };
    walk(root);
    assert.deepEqual(offenders, [],
      `these expand one bound parameter per value and will breach the 100 limit:\n  ${offenders.join('\n  ')}`);
  });
});
