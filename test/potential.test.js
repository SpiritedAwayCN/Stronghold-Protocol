import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getData } from '../server/data.js';
import { DataSource } from '../server/sim/simdata.js';
import { buildBattleSpec, createBattleFromSpec } from '../server/sim/spec.js';
import { unitInfo } from '../server/sim/snapshot.js';
import { chessLoadout, unitLoadout } from '../public/js/ui/gameLogic.js';
import { makeMatch } from './match/harness.js';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';

const data = getData();
const texas = 'chess_char_4_16_b';

test('every operator has all five potential upgrade variants; costs and redeploy timers never increase', () => {
  const source = new DataSource(data);
  for (const rec of Object.values(data.chess).filter((entry) => entry.charId && !entry.isDiy)) {
    for (let rank = 0; rank <= 5; rank++) {
      if (rank) assert.ok(rec.potentials[rank], `${rec.chessId} rank ${rank}`);
      const def = source.getChess(rec.chessId, { potentialRank: rank });
      assert.ok(def.stats.cost <= rec.stats.cost);
      assert.ok(def.stats.respawnTime <= rec.stats.respawnTime);
      assert.ok(Number.isFinite(def.stats.atk));
    }
  }
});

test('potential upgrades follow their actual order and use distinct cached definitions', () => {
  const source = new DataSource(data);
  const base = source.getChess(texas);
  const first = source.getChess(texas, { potentialRank: 1 });
  const third = source.getChess(texas, { potentialRank: 3 });
  const full = source.getChess(texas, { potentialRank: 5 });
  assert.equal(first.stats.cost, base.stats.cost - 1);
  assert.equal(first.stats.atk, base.stats.atk);
  assert.equal(third.stats.respawnTime, base.stats.respawnTime - 2);
  assert.equal(full.stats.cost, base.stats.cost - 2);
  assert.equal(full.stats.atk, base.stats.atk + 22);
  assert.notEqual(full, base);
  assert.equal(source.getChess(texas, { potentialRank: 5 }), full);
  assert.equal(source.getChess(texas, { potentialRank: -1 }), base);
  assert.equal(source.getChess(texas, { potentialRank: 6 }), base);
});

test('potential talent candidates respect promotion status and survive every module selection', () => {
  const source = new DataSource(data);
  for (const rec of Object.values(data.chess).filter((entry) => entry.charId && !entry.isDiy)) {
    for (const rank of [1, 3, 5]) {
      for (const moduleId of rec.modules ? ['none', ...rec.modules.map((mod) => mod.uniEquipId)] : [null]) {
        const def = source.getChess(rec.chessId, { potentialRank: rank, moduleId });
        const preview = chessLoadout(rec, { potentialRank: rank, [rec.baseId]: { module: moduleId || undefined } }, (id) => data.chess[id]).record;
        assert.equal(def.stats.atk, preview.stats.atk, `${rec.chessId} rank ${rank} ${moduleId}`);
        assert.deepEqual(def.talents.map((talent) => talent.bb), preview.talents.map((talent) => talent.bb));
      }
    }
  }
  const full = source.getChess('chess_char_4_07_b', { potentialRank: 5 });
  assert.equal(full.talents.find((talent) => talent.name === '军事传统').bb.sp, 8);
  assert.equal(full.talents.find((talent) => talent.name === '精密填弹').bb.prob, .28);
});

test('human and bot battle inputs, specs, simulation and detail cards agree on the global potential', () => {
  const harness = makeMatch({ potentialRank: 5, bots: 1 });
  try {
    for (const player of harness.m.players.values()) {
      const piece = player.newPiece('chess', texas);
      player.board.set('9,3', piece);
      const input = player.battleInput();
      assert.equal(input.units[0].potentialRank, 5);
      assert.equal(player.privateView().potentialRank, 5);
      assert.equal(harness.m.prepFieldMeta(player).units[0].potentialRank, 5);
      const spec = buildBattleSpec({ seed: 1, stageId: 'act1autochess_m01', players: [input], spawns: [], content: false });
      assert.equal(spec.players[0].units[0].potentialRank, 5);
      const battle = createBattleFromSpec(spec, data);
      battle.start();
      const unit = battle.allies()[0];
      assert.equal(unit.base.cost, data.chess[texas].stats.cost - 2);
      assert.equal(unit.base.respawnTime, data.chess[texas].stats.respawnTime - 2);
      const info = unitInfo(unit);
      const preview = chessLoadout(data.chess[texas], unitLoadout(data.chess[texas], info), (id) => data.chess[id]).record;
      assert.equal(preview.stats.cost, unit.base.cost);
    }
  } finally { harness.m.dispose(); }
});

test('room potential is host-controlled, defaults to full, resets readiness and locks at start', async () => {
  class RecordingMatch extends StubMatch {
    constructor(options) { super(options); RecordingMatch.options = options; }
  }
  const server = await startServer({ port: 0, host: '127.0.0.1', MatchClass: RecordingMatch, log: { info() {}, warn() {}, error() {} } });
  const clients = [];
  try {
    const host = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);
    const guest = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);
    clients.push(host, guest);
    await host.hello('Host'); await guest.hello('Guest');
    assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
    const room = await host.waitFor('room.state');
    assert.equal(room.potentialRank, 5);
    await guest.request({ t: 'room.join', code: room.code });
    assert.equal((await guest.request({ t: 'room.setPotential', potentialRank: 2 })).code, 'NOT_HOST');
    for (const bad of [-1, 6, 2.5, '5']) assert.equal((await host.request({ t: 'room.setPotential', potentialRank: bad })).code, 'BAD_MSG');
    await guest.request({ t: 'room.ready', ready: true });
    assert.equal((await host.request({ t: 'room.setPotential', potentialRank: 2 })).t, 'ok');
    const updated = await guest.waitFor('room.state', (state) => state.potentialRank === 2);
    assert.equal(updated.seats[1].ready, false);
    await guest.request({ t: 'room.ready', ready: true });
    assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
    assert.equal(RecordingMatch.options.potentialRank, 2);
    assert.equal((await host.request({ t: 'room.setPotential', potentialRank: 0 })).code, 'ROOM_STARTED');
  } finally {
    await Promise.all(clients.map((client) => client.terminate()));
    await server.close();
  }
});