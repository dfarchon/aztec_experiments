// Genuine DF onboarding fixture. Never writes PlayerStorage.set or disables ZK checks.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { BarretenbergSync } from '@aztec/bb.js';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { Contract } from '@aztec/aztec.js/contracts';
import { EventSelector, loadContractArtifact } from '@aztec/aztec.js/abi';
import { getPublicEvents } from '@aztec/aztec.js/events';

const root = new URL('../', import.meta.url);
const upstream = new URL('.local/df-upstream/', root);
const load = name => loadContractArtifact(JSON.parse(fs.readFileSync(new URL(`contracts/target/${name}.json`, upstream))));

function zero(type) {
  if (type.kind === 'boolean') return false;
  if (type.kind === 'field' || type.kind === 'integer') return 0n;
  if (type.kind === 'array') return Array.from({ length: type.length }, () => zero(type.type));
  if (type.kind === 'struct') {
    if (type.path.endsWith('::AztecAddress')) return AztecAddress.ZERO;
    return Object.fromEntries(type.fields.map(f => [f.name, zero(f.type)]));
  }
  throw new Error(`Unsupported zero ABI: ${type.kind}`);
}

export async function findSpawn(snark, game, thresholds, radius) {
  // Use the pinned DF client's Perlin implementation; bundle only its pure TS helpers.
  const output = new URL('.local/df-perlin.mjs', root);
  await build({
    entryPoints: [fileURLToPath(new URL('packages/hashing/src/perlin.ts', upstream))],
    outfile: fileURLToPath(output), bundle: true, platform: 'node', format: 'esm',
    external: ['@aztec/*'], nodePaths: [fileURLToPath(new URL('node_modules', root))],
  });
  const { initPoseidon2, perlin } = await import(output.href);
  await initPoseidon2();
  const api = BarretenbergSync.getSingleton();
  const field = n => new Fr((BigInt(n) + Fr.MODULUS) % Fr.MODULUS).toBuffer();
  const key = field(snark.planethash_key);
  const max = BigInt(game.max_location_id.toString());
  for (let i = 0; i < 2_000_000; i++) {
    if (i % 4096 === 0) await new Promise(resolve => setImmediate(resolve));
    const angle = i * 2.399963229728653;
    const distance = radius * (0.9901 + 0.0097 * ((i % 997) / 997));
    const x = Math.trunc(Math.cos(angle) * distance);
    const y = Math.trunc(Math.sin(angle) * distance);
    const squared = BigInt(x) ** 2n + BigInt(y) ** 2n;
    if (squared >= BigInt(radius) ** 2n || squared * 100n <= 98n * BigInt(radius) ** 2n) continue;
    const hash = api.poseidon2Hash({ inputs: [key, field(x), field(y)] }).hash;
    const location = BigInt(`0x${Buffer.from(hash).toString('hex')}`);
    if (location >= max) continue;
    const levelBytes = BigInt(hash[4] * 65536 + hash[5] * 256 + hash[6]);
    if (levelBytes < BigInt(thresholds.thresholds[1])) continue;
    const noise = perlin({ x, y }, {
      key: Number(snark.spacetype_key), scale: Number(snark.perlin_length_scale),
      mirrorX: snark.perlin_mirror_x, mirrorY: snark.perlin_mirror_y, floor: true,
    });
    if (noise >= Number(game.init_perlin_min) && noise < Number(game.init_perlin_max)) {
      console.log(`PASS valid DF spawn found after ${i + 1} candidates (perlin=${noise})`);
      return { x: new Fr(field(x)), y: new Fr(field(y)), location, perlin: noise, candidates: i + 1 };
    }
  }
  throw new Error('No valid spawn found within bounded search; ZK checks remain enabled');
}

export async function deployDFCore({ wallet, admin, send }) {
  const definitions = [
    ['Config', 'config-Config'], ['WorldStorage', 'world-WorldStorage'],
    ['PlayerStorage', 'player-PlayerStorage'], ['PlanetStorage', 'planet-PlanetStorage'],
    ['PlanetRevealedCoordsStorage', 'planet_revealed_coords-PlanetRevealedCoordsStorage'],
    ['PlanetEventsStorage', 'planet_events-PlanetEventsStorage'],
    ['PlanetArtifactsStorage', 'planet_artifacts-PlanetArtifactsStorage'],
    ['ArrivalStorage', 'arrival-ArrivalStorage'], ['ArtifactStorage', 'artifact-ArtifactStorage'],
    ['ArtifactLocationStorage', 'artifact_location-ArtifactLocationStorage'], ['Core', 'core-Core'],
  ];
  const deployed = {};
  for (const [name, artifactName] of definitions) {
    const { contract } = await Contract.deploy(wallet, load(artifactName), [admin]).send({ from: admin });
    deployed[name] = contract;
    console.log(`PASS DF deployed ${name}: ${contract.address}`);
  }
  const { Core: core, Config: config, PlayerStorage: source, WorldStorage: worldStorage } = deployed;
  await send(core.methods.set_all_storage_addresses(...definitions.slice(0, 10).map(([name]) => deployed[name].address)), admin);
  for (const name of ['PlayerStorage', 'PlanetStorage']) {
    await send(deployed[name].methods.add_authorized_contract(core.address), admin);
  }
  await send(config.methods.set_default_configs_batch_1(), admin);
  await send(config.methods.set_default_configs_batch_2(), admin);
  for (let tier = 0; tier < 4; tier++) await send(config.methods.set_default_game_config_planet_type_weights_tier(tier), admin);
  await send(config.methods.set_planet_default_stats(0, {
    population_cap: 100000n, population_growth: 417n, range: 99n, speed: 75n,
    defense: 400n, silver_growth: 0n, silver_cap: 0n, barbarian_percentage: 0n,
  }), admin);
  const world = { paused: false, radius: 53001n, misc_nonce: 0n, next_change_block: 0 };
  await send(worldStorage.methods.set(0n, world), admin);
  return { deployed, source, core, config, world };
}

export async function initializeDFPlayer({ wallet, node, owner, admin, outsider, send, sendPrivate, view }) {
  const { deployed, source, core, config, world } = await deployDFCore({ wallet, admin, send });
  const snark = await view(config.methods.get_snark_config());
  assert.equal(snark.disable_zk_checks, false, 'DF coordinate proof checks must stay enabled');
  const game = await view(config.methods.get_game_config_core());
  const thresholds = await view(config.methods.get_planet_level_thresholds());
  const spawn = await findSpawn(snark, game, thresholds, Number(world.radius));
  const parameters = load('core-Core').functions.find(f => f.name === 'initialize_player').parameters;
  const args = Object.fromEntries(parameters.map(p => [p.name, zero(p.type)]));
  const block = await node.getBlock('latest');
  const timestamp = BigInt(block.header.globalVariables.timestamp.toString());
  Object.assign(args, {
    x: spawn.x, y: spawn.y, radius: world.radius, location_id: spawn.location,
    perlin: spawn.perlin, level: 0, timestamp, provided_snark_config: snark,
    planet_default_stats: await view(config.methods.get_planet_default_stats(0)),
    world_config: await view(config.methods.get_world_config()), game_config_core: game,
    planet_level_thresholds: thresholds,
    space_junk_config: await view(config.methods.get_space_junk_config()), world,
  });
  for (let tier = 0; tier < 4; tier++) args[`planet_type_weights_tier_${tier}`] = await view(config.methods.get_planet_type_weights_tier(tier));
  const call = overrides => core.methods.initialize_player(...parameters.map(p => ({ ...args, ...overrides })[p.name]));
  assert.equal(await view(source.methods.is_initialized(owner)), false);
  assert.equal(await view(source.methods.is_initialized(outsider)), false);
  await assert.rejects(() => call({ location_id: spawn.location + 1n }).simulate({ from: owner }), /Init proof: location hash mismatch/);
  await assert.rejects(() => call({ perlin: spawn.perlin + 1 }).simulate({ from: owner }), /Init proof: perlin mismatch/);
  const initialized = await sendPrivate(call({}));
  assert.equal(await view(source.methods.is_initialized(owner)), true);
  assert.equal(await view(source.methods.is_initialized(outsider)), false);
  const playerAbi = load('player-PlayerStorage').outputs.structs.events.find(e => e.path.endsWith('::PlayerUpdate'));
  const events = await getPublicEvents(node, {
    abiType: playerAbi, eventSelector: EventSelector.fromString('0x6994fffb'),
    fieldNames: playerAbi.fields.map(f => f.name),
  }, { contractAddress: source.address, txHash: initialized.receipt.txHash });
  const matched = events.events.map(e => e.event).filter(e => e.id.toString() === owner.toString());
  assert.equal(matched.length, 1, 'Exactly one PlayerUpdate must be emitted by real Core init');
  const state = matched[0].state;
  assert(BigInt(state.init_timestamp) > 0n);
  assert.equal(BigInt(state.home_planet_id.toString()), spawn.location);
  assert.equal(await view(source.methods.verify(owner, state)), true);
  // Unauthorized users cannot bypass Core by directly creating their own player state.
  await assert.rejects(() => source.methods.set(outsider, state).simulate({ from: outsider }), /Not authorized/);
  await assert.rejects(() => call({}).simulate({ from: owner }), /Player already initialized/);
  assert.equal((await view(config.methods.get_snark_config())).disable_zk_checks, false);
  console.log('PASS Core.initialize_player with ZK checks enabled -> authentic PlayerUpdate');
  return {
    source, state, metadata: {
      contracts: Object.fromEntries(Object.entries(deployed).map(([name, c]) => [name, c.address.toString()])),
      initializeTx: initialized.receipt.txHash.toString(), disableZkChecks: false,
      spawnCandidates: spawn.candidates, homePlanet: spawn.location.toString(),
    },
  };
}
