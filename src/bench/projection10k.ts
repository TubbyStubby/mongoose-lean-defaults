import mongoose from 'mongoose';
import { attachDefaults } from '../index';
import { performance } from 'perf_hooks';

const DOC_COUNT = 10000;
const ITEMS_PER_DOC = 10;
const WARMUP_RUNS = 5;
const MEASURED_RUNS = 9;

export function benchProjection10k() {
  const ItemSchema = new mongoose.Schema(
    {
      name: { type: String, default: 'item' },
      qty: { type: Number, default: 1 },
      meta: {
        tag: { type: String, default: 'tag' },
        note: String,
      },
    },
    { _id: false },
  );

  const Schema = new mongoose.Schema(
    {
      prop1: { type: String, default: 'prop1' },
      prop2: {
        nestedProp1: { type: String, default: 'nestedProp1' },
        nestedProp2: { type: Boolean, default: true },
        nestedProp3: String,
      },
      prop3: { type: Number, default: 3 },
      prop4: { type: String, default: 'prop4' },
      prop5: { type: Boolean, default: false },
      prop6: { type: String, default: 'prop6' },
      prop7: { type: [String], default: ['prop7'] },
      prop8: { type: String, default: 'prop8' },
      items: [ItemSchema],
    },
    { collection: 'bench_projection' },
  );

  const Model = mongoose.model('ProjectionBench', Schema);

  function makeData(count: number) {
    return Array.from({ length: count }, () => ({
      _id: new mongoose.Types.ObjectId(),
      items: Array.from({ length: ITEMS_PER_DOC }, () => ({ name: 'name' })),
    }));
  }

  const cases: Array<[string, Record<string, 0 | 1>]> = [
    ['no projection', {}],
    ['inclusive projection', { prop1: 1, 'prop2.nestedProp1': 1, items: 1 }],
    ['exclusive projection', { prop4: 0, 'items.meta': 0 }],
  ];

  for (const [name, projection] of cases) {
    const query = Model.find().select(projection).lean({ defaults: true });

    for (let i = 0; i < WARMUP_RUNS; i++) {
      attachDefaults.call(query, Schema, makeData(DOC_COUNT));
    }

    const timings: number[] = [];
    for (let i = 0; i < MEASURED_RUNS; i++) {
      const data = makeData(DOC_COUNT);
      const start = performance.now();
      attachDefaults.call(query, Schema, data);
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)];

    console.log(
      `projection10k (${name}): applying defaults took ${median.toFixed(
        2,
      )} ms (median of ${MEASURED_RUNS})`,
    );
  }
}
