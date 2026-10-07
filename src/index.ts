'use strict';
import mpath from 'mpath';
import mongoose, { Schema, Query, Document, SchemaType } from 'mongoose';

export interface MongooseLeanDefaultsOptions {
  defaults?: boolean;
}
interface Default {
  value: unknown | undefined;
  fnValue: ((doc: unknown) => unknown) | undefined;
  pathSegments: string[];
}
interface MapChildSchema {
  path: string;
  schema: Schema;
}

const DEFAULTS_REGISTRY = new WeakMap<Schema, Default[]>();
const MAP_CHILD_SCHEMAS_REGISTRY = new WeakMap<Schema, MapChildSchema[]>();

export default function mongooseLeanDefaults(
  schema: Schema<any, any, any, any>,
  options?: MongooseLeanDefaultsOptions,
): void {
  const fn = attachDefaultsMiddleware(schema, options);
  schema.post('find', fn);
  schema.post('findOne', fn);
  schema.post('findOneAndUpdate', fn);
  schema.post('findOneAndRemove', fn);
  schema.post('findOneAndDelete', fn);
}

function getDefaultsRegistryEntry(schema: Schema): Default[] {
  const existing = DEFAULTS_REGISTRY.get(schema);
  if (existing) {
    return existing;
  }

  const defaults: Default[] = [];
  const mapChildSchemas: MapChildSchema[] = [];
  // Set early so recursive calls to getDefaultsRegistryEntry on this same schema
  // (via getDefault → Embedded/Subdocument check) return [] instead of looping.
  DEFAULTS_REGISTRY.set(schema, defaults);

  schema.eachPath((pathname, schemaType) => {
    if (pathname.endsWith('.$*')) {
      // This is the value schema of a Map field (e.g. "mapField.$*"). There's no
      // single "mapField.$*" key on a real document — each map entry lives under
      // its own runtime key — so it can't be handled like a normal default path.
      // If the map holds subdocuments, register the child schema separately and
      // apply its defaults to every actual key at doc-processing time instead.
      const childSchema = (schemaType as unknown as { schema?: Schema }).schema;
      if (childSchema && getDefaultsRegistryEntry(childSchema).length > 0) {
        mapChildSchemas.push({
          path: pathname.slice(0, -'.$*'.length),
          schema: childSchema,
        });
      }
      return;
    }
    const pathSegments = pathname.split('.');
    const defaultValue = getDefault(schemaType);

    if (defaultValue !== undefined) {
      const isFunc = typeof defaultValue === 'function';
      defaults.push({
        value: isFunc ? undefined : defaultValue,
        fnValue: isFunc ? (defaultValue as Default['fnValue']) : undefined,
        pathSegments,
      });
    }
  });

  DEFAULTS_REGISTRY.set(schema, defaults);
  MAP_CHILD_SCHEMAS_REGISTRY.set(schema, mapChildSchemas);

  return defaults;
}

function getMapChildSchemas(schema: Schema): MapChildSchema[] {
  return MAP_CHILD_SCHEMAS_REGISTRY.get(schema) ?? [];
}

function collectMapValues(data: unknown): unknown[] {
  if (data == null) {
    return [];
  }
  if (Array.isArray(data)) {
    const out: unknown[] = [];
    for (const item of data) {
      out.push(...collectMapValues(item));
    }
    return out;
  }
  if (typeof data === 'object') {
    return Object.values(data as Record<string, unknown>).filter(
      (v) => v != null,
    );
  }
  return [];
}

function attachDefaultsMiddleware(
  schema: Schema,
  options?: MongooseLeanDefaultsOptions,
) {
  return function (this: Query<unknown, Document>, res: unknown) {
    attachDefaults.call(this, schema, res, options);
  };
}

export function attachDefaults(
  this: Query<unknown, Document>,
  schema: Schema,
  res: unknown,
  options?: MongooseLeanDefaultsOptions,
  prefix?: string,
) {
  if (res == null) {
    return res;
  }

  const shouldApplyDefaults: boolean =
    !!this._mongooseOptions.lean &&
    (this._mongooseOptions.lean.defaults ?? options?.defaults ?? false);

  if (shouldApplyDefaults) {
    if (getDefaultsRegistryEntry(schema).length) {
      const defaults = getSelectedDefaults(this, schema, prefix);
      if (Array.isArray(res)) {
        for (let i = 0; i < res.length; ++i) {
          attachDefaultsToDoc(defaults, res[i]);
        }
      } else {
        attachDefaultsToDoc(defaults, res);
      }
    }

    for (let i = 0; i < schema.childSchemas.length; ++i) {
      const _schema = schema.childSchemas[i].schema;
      if (
        !getDefaultsRegistryEntry(_schema).length &&
        !getMapChildSchemas(_schema).length
      ) {
        continue;
      }
      const _path = schema.childSchemas[i].model.path;
      let _doc = mpath.get(_path, res);
      if (Array.isArray(_doc)) {
        _doc = _doc.flat();
        if (_doc.length === 0) {
          continue;
        }
      }
      if (_doc == null) {
        continue;
      }
      attachDefaults.call(
        this,
        _schema,
        _doc,
        options,
        prefix ? `${prefix}.${_path}` : _path,
      );
    }

    const mapChildSchemas = getMapChildSchemas(schema);
    for (let i = 0; i < mapChildSchemas.length; ++i) {
      const { path: _path, schema: _schema } = mapChildSchemas[i];
      const mapValues = collectMapValues(mpath.get(_path, res));
      if (mapValues.length === 0) {
        continue;
      }
      attachDefaults.call(
        this,
        _schema,
        mapValues,
        options,
        prefix ? `${prefix}.${_path}.$*` : `${_path}.$*`,
      );
    }

    return res;
  } else {
    return res;
  }
}

/**
 * Filters the schema's defaults down to the ones the query's projection keeps.
 * The result depends only on (query, schema, prefix), so it is computed once
 * per call rather than once per document.
 */
function getSelectedDefaults(
  query: Query<unknown, Document>,
  schema: Schema,
  prefix?: string,
): Default[] {
  const defaults = getDefaultsRegistryEntry(schema);
  // @ts-expect-error this._fields is private
  const fields: Record<string, unknown> | null = query._fields;
  if (!query.selected() || !fields) {
    return defaults;
  }

  const selectedFieldKeys = Object.keys(fields);
  const inclusive = query.selectedInclusively();
  const exclusive = query.selectedExclusively();

  return defaults.filter((defaultEntry) => {
    const pathname = defaultEntry.pathSegments.join('.');
    const fullPath = prefix ? `${prefix}.${pathname}` : pathname;
    const matchedKey = selectedFieldKeys.find(
      (key) =>
        fullPath === key ||
        fullPath.startsWith(key + '.') ||
        key.startsWith(fullPath + '.'),
    );

    const included = matchedKey && fields[matchedKey] != null;
    if (inclusive && !included) {
      return false;
    }
    if (exclusive && included) {
      return false;
    }
    return true;
  });
}

function attachDefaultsToDoc(defaults: Default[], doc: unknown) {
  if (doc == null) return;
  if (Array.isArray(doc)) {
    for (let i = 0; i < doc.length; ++i) {
      attachDefaultsToDoc(defaults, doc[i]);
    }
    return;
  }

  for (let i = 0; i < defaults.length; i++) {
    const defaultEntry = defaults[i];

    const pathSegments = defaultEntry.pathSegments;
    let cur = doc as Record<string, unknown>;
    const lastIndex = pathSegments.length - 1;
    for (let j = 0; j < lastIndex; ++j) {
      cur[pathSegments[j]] = cur[pathSegments[j]] || {};
      cur = cur[pathSegments[j]] as Record<string, unknown>;
    }

    if (cur[pathSegments[lastIndex]] === undefined) {
      let valueToDefault = defaultEntry.value;
      if (defaultEntry.fnValue) {
        valueToDefault = defaultEntry.fnValue(doc);
      }
      if (valueToDefault !== undefined) {
        cur[pathSegments[lastIndex]] = valueToDefault;
      }
    }
  }
}

function getDefault(schemaType: SchemaType): unknown {
  // @ts-expect-error defaultValue is a valid prop
  if (typeof schemaType.defaultValue === 'function') {
    if (
      // @ts-expect-error defaultValue is a valid prop
      schemaType.defaultValue === Date.now ||
      // @ts-expect-error defaultValue is a valid prop
      schemaType.defaultValue === Array ||
      // @ts-expect-error defaultValue is a valid prop
      schemaType.defaultValue.name.toLowerCase() === 'objectid'
    ) {
      return function (doc: unknown) {
        // @ts-expect-error defaultValue is a valid prop
        return schemaType.defaultValue.call(doc);
      };
    } else {
      return function (doc: unknown) {
        // @ts-expect-error defaultValue is a valid prop
        return schemaType.defaultValue.call(doc, doc);
      };
    }
  } else if (
    Object.prototype.hasOwnProperty.call(schemaType.options, 'default')
  ) {
    // Sanity check for function defaults
    if (typeof schemaType.options.default === 'function') {
      return function (doc: unknown) {
        return schemaType.options.default.call(doc, doc);
      };
    }
    return schemaType.options.default;
  } else if (
    ('Embedded' in mongoose.Schema.Types &&
      // @ts-expect-error Embedded exists in mongoose@5
      schemaType instanceof mongoose.Schema.Types.Embedded) ||
    ('Subdocument' in mongoose.Schema.Types &&
      schemaType instanceof mongoose.Schema.Types.Subdocument)
  ) {
    // Only create an empty-object factory when the child schema has fields with
    // actual defaults — otherwise the embedded field should remain absent.
    const childSchema: Schema | undefined = (schemaType as any).schema;
    if (childSchema && getDefaultsRegistryEntry(childSchema).length > 0) {
      return function () {
        return {};
      };
    }
    // @ts-expect-error defaultValue is a valid prop
    return schemaType.defaultValue;
  } else {
    // @ts-expect-error defaultValue is a valid prop
    return schemaType.defaultValue;
  }
}
