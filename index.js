'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachDefaults = void 0;
const mpath_1 = __importDefault(require("mpath"));
const mongoose_1 = __importDefault(require("mongoose"));
const DEFAULTS_REGISTRY = new WeakMap();
const MAP_CHILD_SCHEMAS_REGISTRY = new WeakMap();
function mongooseLeanDefaults(schema, options) {
    const fn = attachDefaultsMiddleware(schema, options);
    schema.post('find', fn);
    schema.post('findOne', fn);
    schema.post('findOneAndUpdate', fn);
    schema.post('findOneAndRemove', fn);
    schema.post('findOneAndDelete', fn);
}
exports.default = mongooseLeanDefaults;
function getDefaultsRegistryEntry(schema) {
    const existing = DEFAULTS_REGISTRY.get(schema);
    if (existing) {
        return existing;
    }
    const defaults = [];
    const mapChildSchemas = [];
    DEFAULTS_REGISTRY.set(schema, defaults);
    schema.eachPath((pathname, schemaType) => {
        if (pathname.endsWith('.$*')) {
            const childSchema = schemaType.schema;
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
                fnValue: isFunc ? defaultValue : undefined,
                pathSegments,
            });
        }
    });
    DEFAULTS_REGISTRY.set(schema, defaults);
    MAP_CHILD_SCHEMAS_REGISTRY.set(schema, mapChildSchemas);
    return defaults;
}
function getMapChildSchemas(schema) {
    var _a;
    return (_a = MAP_CHILD_SCHEMAS_REGISTRY.get(schema)) !== null && _a !== void 0 ? _a : [];
}
function collectMapValues(data) {
    if (data == null) {
        return [];
    }
    if (Array.isArray(data)) {
        const out = [];
        for (const item of data) {
            out.push(...collectMapValues(item));
        }
        return out;
    }
    if (typeof data === 'object') {
        return Object.values(data).filter((v) => v != null);
    }
    return [];
}
function attachDefaultsMiddleware(schema, options) {
    return function (res) {
        attachDefaults.call(this, schema, res, options);
    };
}
function attachDefaults(schema, res, options, prefix) {
    var _a, _b;
    if (res == null) {
        return res;
    }
    const shouldApplyDefaults = !!this._mongooseOptions.lean &&
        ((_b = (_a = this._mongooseOptions.lean.defaults) !== null && _a !== void 0 ? _a : options === null || options === void 0 ? void 0 : options.defaults) !== null && _b !== void 0 ? _b : false);
    if (shouldApplyDefaults) {
        if (getDefaultsRegistryEntry(schema).length) {
            const defaults = getSelectedDefaults(this, schema, prefix);
            if (Array.isArray(res)) {
                for (let i = 0; i < res.length; ++i) {
                    attachDefaultsToDoc(defaults, res[i]);
                }
            }
            else {
                attachDefaultsToDoc(defaults, res);
            }
        }
        for (let i = 0; i < schema.childSchemas.length; ++i) {
            const _schema = schema.childSchemas[i].schema;
            if (!getDefaultsRegistryEntry(_schema).length &&
                !getMapChildSchemas(_schema).length) {
                continue;
            }
            const _path = schema.childSchemas[i].model.path;
            let _doc = mpath_1.default.get(_path, res);
            if (Array.isArray(_doc)) {
                _doc = _doc.flat();
                if (_doc.length === 0) {
                    continue;
                }
            }
            if (_doc == null) {
                continue;
            }
            attachDefaults.call(this, _schema, _doc, options, prefix ? `${prefix}.${_path}` : _path);
        }
        const mapChildSchemas = getMapChildSchemas(schema);
        for (let i = 0; i < mapChildSchemas.length; ++i) {
            const { path: _path, schema: _schema } = mapChildSchemas[i];
            const mapValues = collectMapValues(mpath_1.default.get(_path, res));
            if (mapValues.length === 0) {
                continue;
            }
            attachDefaults.call(this, _schema, mapValues, options, prefix ? `${prefix}.${_path}.$*` : `${_path}.$*`);
        }
        return res;
    }
    else {
        return res;
    }
}
exports.attachDefaults = attachDefaults;
function getSelectedDefaults(query, schema, prefix) {
    const defaults = getDefaultsRegistryEntry(schema);
    const fields = query._fields;
    if (!query.selected() || !fields) {
        return defaults;
    }
    const selectedFieldKeys = Object.keys(fields);
    const inclusive = query.selectedInclusively();
    const exclusive = query.selectedExclusively();
    return defaults.filter((defaultEntry) => {
        const pathname = defaultEntry.pathSegments.join('.');
        const fullPath = prefix ? `${prefix}.${pathname}` : pathname;
        const matchedKey = selectedFieldKeys.find((key) => fullPath === key ||
            fullPath.startsWith(key + '.') ||
            key.startsWith(fullPath + '.'));
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
function attachDefaultsToDoc(defaults, doc) {
    if (doc == null)
        return;
    if (Array.isArray(doc)) {
        for (let i = 0; i < doc.length; ++i) {
            attachDefaultsToDoc(defaults, doc[i]);
        }
        return;
    }
    for (let i = 0; i < defaults.length; i++) {
        const defaultEntry = defaults[i];
        const pathSegments = defaultEntry.pathSegments;
        let cur = doc;
        const lastIndex = pathSegments.length - 1;
        for (let j = 0; j < lastIndex; ++j) {
            cur[pathSegments[j]] = cur[pathSegments[j]] || {};
            cur = cur[pathSegments[j]];
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
function getDefault(schemaType) {
    if (typeof schemaType.defaultValue === 'function') {
        if (schemaType.defaultValue === Date.now ||
            schemaType.defaultValue === Array ||
            schemaType.defaultValue.name.toLowerCase() === 'objectid') {
            return function (doc) {
                return schemaType.defaultValue.call(doc);
            };
        }
        else {
            return function (doc) {
                return schemaType.defaultValue.call(doc, doc);
            };
        }
    }
    else if (Object.prototype.hasOwnProperty.call(schemaType.options, 'default')) {
        if (typeof schemaType.options.default === 'function') {
            return function (doc) {
                return schemaType.options.default.call(doc, doc);
            };
        }
        return schemaType.options.default;
    }
    else if (('Embedded' in mongoose_1.default.Schema.Types &&
        schemaType instanceof mongoose_1.default.Schema.Types.Embedded) ||
        ('Subdocument' in mongoose_1.default.Schema.Types &&
            schemaType instanceof mongoose_1.default.Schema.Types.Subdocument)) {
        const childSchema = schemaType.schema;
        if (childSchema && getDefaultsRegistryEntry(childSchema).length > 0) {
            return function () {
                return {};
            };
        }
        return schemaType.defaultValue;
    }
    else {
        return schemaType.defaultValue;
    }
}
