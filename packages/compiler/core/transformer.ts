import { $computed, isIntrinsic } from "../lib/decorators.js";
import { compilerAssert } from "./diagnostics.js";
import { Program } from "./program.js";
import { isTemplateInstance } from "./type-utils.js";
import { ModelType, ModelTypeProperty, Type } from "./types.js";

export interface ModelTransformer {
  transform<T extends Type>(type: T, inItem?: boolean): T;
  transform<T extends Type>(type: T | undefined, inItem?: boolean): T | undefined;
}

export interface ModelTransformerOptions {
  suffix?: string;
  itemSuffix?: string;
  excludeType?: (type: Type) => void;
  transform: (property: ModelTypeProperty, change: PropertyChanger) => void;
  itemTransform?: (property: ModelTypeProperty, change: PropertyChanger) => void;
}

export interface PropertyChanger {
  delete(): void;
  makeOptional(): void;
  changeType(newType: Type): void;
}

export function createModelTransformer(
  program: Program,
  options: ModelTransformerOptions
): ModelTransformer {
  const inItemTransformer = options.itemTransform
    ? createModelTransformer(program, {
        suffix: (options.suffix ?? "") + options.itemSuffix,
        transform: options.itemTransform,
      })
    : undefined;

  const transformed = new Map<Type, Type>();
  const unfinished = new WeakSet<Type>();
  return { transform };

  function transform<T extends Type>(type: T, inItem?: boolean): T;
  function transform<T extends Type>(type: T | undefined, inItem?: boolean): T | undefined;
  function transform<T extends Type>(type: T | undefined, inItem = false): T | undefined {
    if (!type) {
      return undefined;
    }
    if (!type || !isTransformable(type)) {
      return type;
    }
    if (inItem && inItemTransformer) {
      return inItemTransformer.transform(type);
    }

    let newType = transformed.get(type);
    if (!newType) {
      if (options.excludeType?.(type)) {
        newType = type;
      } else {
        newType = transformCore(type);
        newType = finishType(newType);
      }
      transformed.set(type, newType);
    }

    compilerAssert(
      newType.kind === type.kind,
      "It should not be possible to change Type kind in transformation."
    );
    return newType as T;
  }

  function isTransformable(type: Type) {
    return type.kind === "Model" && !isIntrinsic(program, type); //&& !isArrayModelType(program, type);
  }

  function transformCore(type: Type): Type {
    switch (type.kind) {
      case "Model":
        return transformModel(type);
      default:
        compilerAssert(false, "Should be unreachable as we should have accounted for everything.");
    }
  }

  function startTransform(type: Type, newType: Type): void {
    transformed.set(type, newType);
  }

  function createType<T extends Type>(type: T): T {
    const newType = program.checker.createType(type);
    unfinished.add(newType);
    return newType;
  }

  function finishType(newType: Type): Type {
    if (unfinished.has(newType)) {
      unfinished.delete(newType);
      return program.checker.finishType(newType);
    }
    return newType;
  }

  function transformModel(model: ModelType): ModelType {
    const newProperties = new Map<string, ModelTypeProperty>();
    let newModel: ModelType = createType({
      ...model,
      name: "",
      derivedModels: [],
      decorators: [...model.decorators, { decorator: $computed, args: [] }],
      baseModel: transform(model.baseModel),
      properties: newProperties,
    });
    let changedModel = newModel.baseModel !== model.baseModel;

    startTransform(model, newModel);

    if (model.indexer?.value) {
      newModel.indexer = {
        ...model.indexer,
        value: transform(model.indexer.value, true),
      };
      changedModel ||= newModel.indexer.value !== model.indexer.value;
    }

    if (isTemplateInstance(model)) {
      model.templateArguments = model.templateArguments.map((t) => transform(t));
    }

    for (const property of model.properties.values()) {
      let deleted = false;
      const changes: Partial<ModelTypeProperty> = {
        decorators: [...property.decorators, { decorator: $computed, args: [] }],
        model: newModel,
        type: property.type,
      };

      if (property.sourceProperty) {
        const newSourceModel = transform(property.sourceProperty.model);
        changes.sourceProperty = newSourceModel?.properties.get(property.name);
        changedModel ||= property.sourceProperty !== property.sourceProperty;
      }

      const changer: PropertyChanger = {
        delete() {
          changedModel ||= true;
          deleted = true;
        },
        makeOptional() {
          if (!property.optional) {
            changedModel ||= true;
            changes.optional = true;
          }
        },
        changeType(newType) {
          changedModel ||= true;
          changes.type = newType;
        },
      };

      options.transform(property, changer);
      if (deleted) {
        continue;
      }

      changes.type = transform(changes.type);
      changedModel ||= changes.type !== property.type;

      const newProperty = program.checker.cloneType(property, changes);
      newProperties.set(property.name, newProperty);
    }

    if (!changedModel) {
      return model;
    }

    for (const derivedModel of model.derivedModels) {
      transform(derivedModel);
    }
    newModel = program.checker.getEffectiveModelType(newModel);

    if (model.name && !isTemplateInstance(model) && !newModel.name) {
      newModel.name = model.name + options.suffix;
    }

    return newModel;
  }
}
