import { isArrayModelType, isIntrinsic } from "../lib/decorators.js";
import { compilerAssert } from "./diagnostics.js";
import { Program } from "./program.js";
import { ModelType, ModelTypeProperty, Type } from "./types.js";

export interface ModelTransformer {
  transform<T extends Type>(type: T): T;
  transform<T extends Type>(type: T | undefined): T | undefined;
}

export interface PropertyChanger {
  delete(): void;
  makeOptional(): void;
  changeType(newType: Type): void;
}

export type PropertyTransformer = (property: ModelTypeProperty, change: PropertyChanger) => void;

export function createModelTransformer(
  program: Program,
  suffix: string,
  transformProperty: (property: ModelTypeProperty, change: PropertyChanger) => void
): ModelTransformer {
  const transformed = new Map<Type, Type>();
  return { transform };

  function transform<T extends Type>(type: T): T;
  function transform<T extends Type>(type: T | undefined): T | undefined;
  function transform<T extends Type>(type: T | undefined): T | undefined {
    if (!type) {
      return undefined;
    }

    if (!isTransformable(type)) {
      return type;
    }

    const newType = transformed.get(type) ?? transformCore(type);
    postTransform(newType);

    compilerAssert(
      newType.kind === type.kind,
      "It should not be possible to change Type kind in transformation."
    );

    return newType as T;
  }

  function isTransformable(type: Type) {
    return type.kind === "Model" && !isIntrinsic(program, type) && !isArrayModelType(program, type);
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

  function finishTransform<T extends Type>(type: T, newType: T): T {
    const finished = program.checker.finishType(type);
    transformed.set(type, newType);
    postTransform(finished);
    return newType;
  }

  function postTransform(type: Type): void {
    switch (type.kind) {
      case "Model":
        postTransformModel(type);
        break;
    }
  }

  function transformModel(model: ModelType): ModelType {
    const newProperties = new Map<string, ModelTypeProperty>();
    const newModel = program.checker.createType({
      ...model,
      derivedModels: [],
      decorators: [...model.decorators],
      baseModel: transform(model.baseModel),
      name: model.name ? model.name + suffix : "",
      properties: newProperties,
    });
    let changedModel = newModel.baseModel !== model.baseModel;

    startTransform(model, newModel);

    for (const property of model.properties.values()) {
      let deleted = false;
      const changes: Partial<ModelTypeProperty> = {
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

      transformProperty(property, changer);
      if (deleted) {
        continue;
      }

      changes.type = transform(changes.type);
      changedModel ||= changes.type !== property.type;

      const newProperty = program.checker.cloneType(property, changes);
      newProperties.set(property.name, newProperty);
    }

    return finishTransform(model, changedModel ? model : newModel);
  }

  function postTransformModel(model: ModelType) {
    for (const each of model.derivedModels) {
      transform(each);
    }
  }
}
