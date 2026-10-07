import mongoose, { Schema } from 'mongoose';
import mongooseLeanDefaults, { attachDefaults } from '..';

const { MONGO_URI = 'mongodb://localhost:27017/mongooseLeanDefaults' } =
  process.env;

const FIXED_DATE = new Date('2020-01-01T00:00:00.000Z');

const itemSchema = new Schema(
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

const entrySchema = new Schema(
  {
    role: { type: String, default: 'member' },
    count: { type: Number, default: 0 },
  },
  { _id: false },
);

const profileSchema = new Schema(
  {
    bio: { type: String, default: 'bio' },
    items: [itemSchema],
  },
  { _id: false },
);

const schema = new Schema(
  {
    title: { type: String, default: 'title' },
    titleSuffix: { type: String, default: 'suffix' },
    stats: {
      wins: { type: Number, default: 0 },
      losses: { type: Number, default: 0 },
    },
    createdAt: { type: Date, default: () => FIXED_DATE },
    profile: profileSchema,
    items: [itemSchema],
    entries: { type: Map, of: entrySchema },
  },
  { collection: 'projection_parity' },
);

schema.plugin(mongooseLeanDefaults);

const DOCS = [
  { _id: new mongoose.Types.ObjectId('000000000000000000000001') },
  {
    _id: new mongoose.Types.ObjectId('000000000000000000000002'),
    title: 'set',
    stats: { wins: 3 },
    profile: { items: [{}, { name: 'named' }, { meta: { note: 'n' } }] },
    items: [{}, { qty: 5 }, { meta: {} }],
    entries: { a: {}, b: { role: 'admin' } },
  },
  {
    _id: new mongoose.Types.ObjectId('000000000000000000000003'),
    profile: {},
    items: [],
    entries: { c: { count: 7 } },
  },
];

const PROJECTIONS: Array<Record<string, 0 | 1>> = [
  {},
  { title: 1 },
  { title: 1, _id: 0 },
  { 'stats.wins': 1 },
  { stats: 1 },
  { profile: 1 },
  { 'profile.bio': 1 },
  { 'profile.items': 1 },
  { 'profile.items.name': 1 },
  { 'profile.items.meta': 1 },
  { items: 1 },
  { 'items.meta.tag': 1, 'items.qty': 1 },
  { entries: 1 },
  { 'entries.a': 1 },
  { title: 1, 'profile.items.qty': 1, items: 1, entries: 1 },
  { title: 0 },
  { _id: 0 },
  { stats: 0 },
  { 'stats.wins': 0 },
  { profile: 0 },
  { 'profile.items': 0 },
  { 'profile.items.qty': 0 },
  { items: 0 },
  { 'items.meta': 0, 'items.name': 0 },
  { entries: 0 },
  { 'entries.b': 0 },
  { title: 0, createdAt: 0, 'profile.bio': 0, 'items.qty': 0 },
];

const STORED_IDS = new Set(DOCS.map((doc) => doc._id.toHexString()));

// An `_id: 0` inside an inclusive projection still gets a freshly generated
// default `_id`; mask it so the snapshot stays deterministic.
function maskGeneratedId(doc: any) {
  if (doc._id && !STORED_IDS.has(String(doc._id))) {
    return { ...doc, _id: '<generated>' };
  }
  return doc;
}

describe('projection parity', () => {
  let MyModel: mongoose.Model<any>;
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    MyModel = mongoose.model('ProjectionParity', schema);
    await MyModel.deleteMany({}).exec();
    await MyModel.collection.insertMany(DOCS);
  });

  afterAll(async () => {
    await MyModel.deleteMany({}).exec();
    await mongoose.disconnect();
  });

  // Snapshots were recorded against 2.3.5, before projection selection was cached.
  it.each(
    PROJECTIONS.map((projection) => [JSON.stringify(projection), projection]),
  )(
    'find with projection %s matches 2.3.5 output',
    async (_name, projection) => {
      const docs = await MyModel.find({})
        .sort({ _id: 1 })
        .select(projection)
        .lean({ defaults: true })
        .exec();
      expect(docs.map(maskGeneratedId)).toMatchSnapshot();

      const one = await MyModel.findOne({ _id: DOCS[1]._id })
        .select(projection)
        .lean({ defaults: true })
        .exec();
      expect(maskGeneratedId(one)).toEqual(maskGeneratedId(docs[1]));
    },
  );

  it('re-evaluates the projection when the same query object is reused', () => {
    const query = MyModel.find({})
      .select({ title: 1 })
      .lean({ defaults: true });
    const first = attachDefaults.call(query, schema, [{}]);
    expect(first).toEqual([{ title: 'title' }]);

    query.select({ titleSuffix: 1 });
    const second = attachDefaults.call(query, schema, [{}]);
    expect(second).toEqual([{ title: 'title', titleSuffix: 'suffix' }]);
  });
});
