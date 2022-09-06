import {
  compilerAssert,
  createDiagnosticCollector,
  DecoratorContext,
  Diagnostic,
  DiagnosticCollector,
  filterModelProperties,
  getServiceNamespace,
  Interface,
  isArrayModelType,
  isGlobalNamespace,
  isIntrinsic,
  isTemplateDeclaration,
  isTemplateDeclarationOrInstance,
  isVisible as isVisibleCore,
  ModelProperty,
  Namespace,
  Operation,
  Program,
  Type,
  validateDecoratorTarget,
  walkPropertiesInherited,
} from "@cadl-lang/compiler";
import { createDiagnostic, createStateSymbol, reportDiagnostic } from "../lib.js";
import {
  getAction,
  getCollectionAction,
  getResourceOperation,
  getSegment,
  getSegmentSeparator,
} from "../rest.js";
import { extractParamsFromPath } from "../utils.js";
import {
  getHeaderFieldName,
  getOperationVerb,
  getPathParamName,
  getQueryParamName,
  HttpVerb,
  isBody,
  isHeader,
  isPathParam,
  isQueryParam,
  isStatusCode,
} from "./decorators.js";
import { getResponsesForOperation, HttpOperationResponse } from "./responses.js";

export type OperationContainer = Namespace | Interface;

export interface FilteredRouteParam {
  routeParamString?: string;
  excludeFromOperationParams?: boolean;
}

export interface AutoRouteOptions {
  routeParamFilter?: (op: Operation, param: ModelProperty) => FilteredRouteParam | undefined;
}

export interface RouteOptions {
  autoRouteOptions?: AutoRouteOptions;
}

export interface HttpOperationParameter {
  type: "query" | "path" | "header";
  name: string;
  param: ModelProperty;
}

export interface HttpOperationParameters {
  parameters: HttpOperationParameter[];
  bodyType?: Type;
  bodyParameter?: ModelProperty;
}

export interface OperationDetails {
  path: string;
  pathFragment?: string;
  verb: HttpVerb;
  container: OperationContainer;
  parameters: HttpOperationParameters;
  responses: HttpOperationResponse[];
  operation: Operation;
}

export interface RoutePath {
  path: string;
  isReset: boolean;
}

// REVIEW: It ends up being helpful to store visibility as flags in an enum.
//         Currently core visibility API is still string[] and these flags are used
//         only by rest lib / openapi emitter. Can we push this down? Or does core
//         still require that visibility can be any string?
export enum Visibility {
  Read = 1 << 0,
  Create = 1 << 1,
  Update = 1 << 2,
  Delete = 1 << 3,
  Query = 1 << 4,

  All = Read | Create | Update | Delete | Query,

  /**
   * Additional flag to indicate when something is nested in a collection
   * and therefore no metadata is applicable.
   */
  Item = 1 << 20,
}

const visibilityToArrayMap: Map<Visibility, string[]> = new Map();
function visibilityToArray(visibility: Visibility): readonly string[] {
  // Item flag is not a real visibility.
  visibility &= ~Visibility.Item;

  let result = visibilityToArrayMap.get(visibility);
  if (!result) {
    result = [];

    if (visibility & Visibility.Read) {
      result.push("read");
    }
    if (visibility & Visibility.Create) {
      result.push("create");
    }
    if (visibility & Visibility.Update) {
      result.push("update");
    }
    if (visibility & Visibility.Delete) {
      result.push("delete");
    }
    if (visibility & Visibility.Query) {
      result.push("query");
    }

    compilerAssert(result.length > 0, "invalid visibility");
    visibilityToArrayMap.set(visibility, result);
  }

  return result;
}

export function getVisibilitySuffix(visibility: Visibility) {
  let suffix = "";

  if ((visibility & ~Visibility.Item) !== Visibility.Read) {
    const visibilities = visibilityToArray(visibility);
    suffix += visibilities.map((v) => v[0].toUpperCase() + v.slice(1)).join("Or");
  }

  if (visibility & Visibility.Item) {
    suffix += "Item";
  }

  return suffix;
}

/**
 * `@route` defines the relative route URI for the target operation
 *
 * The first argument should be a URI fragment that may contain one or more path parameter fields.
 * If the namespace or interface that contains the operation is also marked with a `@route` decorator,
 * it will be used as a prefix to the route URI of the operation.
 *
 * `@route` can only be applied to operations, namespaces, and interfaces.
 */
export function $route(context: DecoratorContext, entity: Type, path: string) {
  setRoute(context, entity, {
    path,
    isReset: false,
  });
}

export function $routeReset(context: DecoratorContext, entity: Type, path: string) {
  setRoute(context, entity, {
    path,
    isReset: true,
  });
}

const routeOptionsKey = createStateSymbol("routeOptions");
export function setRouteOptionsForNamespace(
  program: Program,
  namespace: Namespace,
  options: RouteOptions
) {
  program.stateMap(routeOptionsKey).set(namespace, options);
}

function getRouteOptionsForNamespace(
  program: Program,
  namespace: Namespace
): RouteOptions | undefined {
  return program.stateMap(routeOptionsKey).get(namespace);
}

const routesKey = createStateSymbol("routes");
function setRoute(context: DecoratorContext, entity: Type, details: RoutePath) {
  if (
    !validateDecoratorTarget(context, entity, "@route", ["Namespace", "Interface", "Operation"])
  ) {
    return;
  }

  const state = context.program.stateMap(routesKey);

  if (state.has(entity)) {
    if (entity.kind === "Operation" || entity.kind === "Interface") {
      reportDiagnostic(context.program, {
        code: "duplicate-route-decorator",
        messageId: entity.kind === "Operation" ? "operation" : "interface",
        target: entity,
      });
    } else {
      const existingValue: RoutePath = state.get(entity);
      if (existingValue.path !== details.path) {
        reportDiagnostic(context.program, {
          code: "duplicate-route-decorator",
          messageId: "namespace",
          target: entity,
        });
      }
    }
  } else {
    state.set(entity, details);
  }
}

export function getRoutePath(
  program: Program,
  entity: Namespace | Interface | Operation
): RoutePath | undefined {
  return program.stateMap(routesKey).get(entity);
}

// The set of allowed segment separator characters
const AllowedSegmentSeparators = ["/", ":"];

function normalizeFragment(fragment: string) {
  if (fragment.length > 0 && AllowedSegmentSeparators.indexOf(fragment[0]) < 0) {
    // Insert the default separator
    fragment = `/${fragment}`;
  }

  // Trim any trailing slash
  return fragment.replace(/\/$/g, "");
}

function buildPath(pathFragments: string[]) {
  // Join all fragments with leading and trailing slashes trimmed
  const path =
    pathFragments.length === 0
      ? "/"
      : pathFragments
          .map(normalizeFragment)
          .filter((x) => x !== "")
          .join("");

  // The final path must start with a '/'
  return path.length > 0 && path[0] === "/" ? path : `/${path}`;
}

function addSegmentFragment(program: Program, target: Type, pathFragments: string[]) {
  // Don't add the segment prefix if it is meant to be excluded
  // (empty string means exclude the segment)
  const segment = getSegment(program, target);
  const separator = getSegmentSeparator(program, target);
  if (segment && segment !== "") {
    pathFragments.push(`${separator ?? "/"}${segment}`);
  }
}

export function getRequestVisibility(verb: HttpVerb): Visibility {
  switch (verb) {
    case "get":
    case "head":
      return Visibility.Query;
    case "post":
      return Visibility.Create;
    case "put":
      return Visibility.Create | Visibility.Update;
    case "patch":
      return Visibility.Update;
    case "delete":
      return Visibility.Delete;

    default:
      const _assertNever: never = verb;
      compilerAssert(false, "unreachable");
  }
}

export function gatherMetadata(
  program: Program,
  diagnostics: DiagnosticCollector,
  type: Type,
  visibility: Visibility
): Set<ModelProperty> {
  if (type.kind !== "Model") {
    return new Set();
  }

  if (isIntrinsic(program, type) || isArrayModelType(program, type)) {
    return new Set();
  }

  const visited = new Set();
  const metadata = new Map<string, ModelProperty>();
  const queue = [type];

  while (queue.length > 0) {
    const model = queue.shift()!; // REVIEW: This is probably not an efficient way to queue.
    visited.add(model);

    for (const property of walkPropertiesInherited(model)) {
      if (!isVisible(program, property, visibility)) {
        continue;
      }

      // REVIEW: Proposal says duplicates are "invalid" metadata and invalid
      // metadata is not an error but becomes part of the schema. This is
      // problematic, though, because it creates an an unbounded number of
      // variants of the same model, depending on where it is referenced.
      // Keeping track of these and naming them is especially hard.
      //
      // I propose making it an error, but that currently breaks some
      // samples and tests.
      //
      // The traversal here is level order so that the preferred metadata in
      // the case of duplicates (ultimately for error recovery when
      // diagnostic is added) is the least deep, which seems least
      // surprising and most compatible with prior behavior.
      if (metadata.has(property.name)) {
        // TODO: diagnostics.add(...)
        continue;
      }

      if (isApplicableMetadataOrBody(program, property, visibility)) {
        metadata.set(property.name, property);
      }

      if (
        property.type.kind === "Model" &&
        !isIntrinsic(program, property.type) &&
        !isArrayModelType(program, property.type) &&
        !visited.has(property.type)
      ) {
        queue.push(property.type);
      }
    }
  }

  return new Set(metadata.values());
}

// REVIEW: Move these helpers out of route.ts

export function isMetadata(program: Program, property: ModelProperty) {
  return (
    isHeader(program, property) ||
    isQueryParam(program, property) ||
    isPathParam(program, property) ||
    isStatusCode(program, property)
  );
}

export function isVisible(program: Program, property: ModelProperty, visibility: Visibility) {
  return isVisibleCore(program, property, visibilityToArray(visibility));
}

export function isApplicableMetadata(
  program: Program,
  property: ModelProperty,
  visibility: Visibility
) {
  return isApplicableMetadataCore(program, property, visibility, false);
}

export function isApplicableMetadataOrBody(
  program: Program,
  property: ModelProperty,
  visibility: Visibility
) {
  return isApplicableMetadataCore(program, property, visibility, true);
}

function isApplicableMetadataCore(
  program: Program,
  property: ModelProperty,
  visibility: Visibility,
  treatBodyAsMetadata: boolean
) {
  if (visibility & Visibility.Item) {
    return false; // no metadata is applicable to collection items
  }

  if (treatBodyAsMetadata && isBody(program, property)) {
    return true;
  }

  if (!isMetadata(program, property)) {
    return false;
  }

  if (visibility === Visibility.Read) {
    return isHeader(program, property) || isStatusCode(program, property);
  }

  if (!(visibility & Visibility.Read)) {
    return !isStatusCode(program, property);
  }

  return true;
}

export function getOperationParameters(
  program: Program,
  verb: HttpVerb,
  operation: Operation
): [HttpOperationParameters, readonly Diagnostic[]] {
  const diagnostics = createDiagnosticCollector();
  const visibility = getRequestVisibility(verb);
  const metadata = gatherMetadata(program, diagnostics, operation.parameters, visibility);

  const result: HttpOperationParameters = {
    parameters: [],
  };
  for (const param of metadata) {
    const queryParam = getQueryParamName(program, param);
    const pathParam = getPathParamName(program, param);
    const headerParam = getHeaderFieldName(program, param);
    const bodyParam = isBody(program, param);

    const defined = [
      ["query", queryParam],
      ["path", pathParam],
      ["header", headerParam],
      ["body", bodyParam],
    ].filter((x) => !!x[1]);
    if (defined.length >= 2) {
      diagnostics.add(
        createDiagnostic({
          code: "operation-param-duplicate-type",
          format: { paramName: param.name, types: defined.map((x) => x[0]).join(", ") },
          target: param, // REVIEW: bad location for nested metadata, should elaborate the context that pulled it in to an operation.
        })
      );
    }

    if (queryParam) {
      result.parameters.push({ type: "query", name: queryParam, param });
    } else if (pathParam) {
      if (param.optional && param.default === undefined) {
        reportDiagnostic(program, {
          code: "optional-path-param",
          format: { paramName: param.name },
          target: operation,
        });
      }
      result.parameters.push({ type: "path", name: pathParam, param });
    } else if (headerParam) {
      result.parameters.push({ type: "header", name: headerParam, param });
    } else if (bodyParam) {
      if (result.bodyType === undefined) {
        result.bodyParameter = param;
        result.bodyType = param.type;
      } else {
        diagnostics.add(createDiagnostic({ code: "duplicate-body", target: param }));
      }
    }
  }

  const unannotatedParameters = filterModelProperties(
    program,
    operation.parameters,
    (p) => !isApplicableMetadataOrBody(program, p, visibility)
  );

  if (unannotatedParameters.properties.size > 0) {
    if (result.bodyType === undefined) {
      result.bodyType = unannotatedParameters;
    } else {
      diagnostics.add(
        createDiagnostic({
          code: "duplicate-body",
          messageId: "bodyAndUnannotated",
          target: operation,
        })
      );
    }
  }

  return diagnostics.wrap(result);
}

function generatePathFromParameters(
  program: Program,
  operation: Operation,
  pathFragments: string[],
  parameters: HttpOperationParameters,
  options: RouteOptions
) {
  const filteredParameters: HttpOperationParameter[] = [];
  for (const httpParam of parameters.parameters) {
    const { type, param } = httpParam;
    if (type === "path") {
      addSegmentFragment(program, param, pathFragments);

      const filteredParam = options.autoRouteOptions?.routeParamFilter?.(operation, param);
      if (filteredParam?.routeParamString) {
        pathFragments.push(`/${filteredParam.routeParamString}`);

        if (filteredParam?.excludeFromOperationParams === true) {
          // Skip the rest of the loop so that we don't add the parameter to the final list
          continue;
        }
      } else {
        // Add the path variable for the parameter
        if (param.type.kind === "String") {
          pathFragments.push(`/${param.type.value}`);
          continue; // Skip adding to the parameter list
        } else {
          pathFragments.push(`/{${param.name}}`);
        }
      }
    }

    // Push all usable parameters to the filtered list
    filteredParameters.push(httpParam);
  }

  // Replace the original parameters with filtered set
  parameters.parameters = filteredParameters;

  // Add the operation's own segment if present
  addSegmentFragment(program, operation, pathFragments);
}

function getPathForOperation(
  program: Program,
  diagnostics: DiagnosticCollector,
  operation: Operation,
  routeFragments: string[],
  verb: HttpVerb,
  options: RouteOptions
): { path: string; pathFragment?: string; parameters: HttpOperationParameters } {
  const parameters = diagnostics.pipe(getOperationParameters(program, verb, operation));
  const pathFragments = [...routeFragments];
  const routePath = getRoutePath(program, operation);
  if (isAutoRoute(program, operation)) {
    // The operation exists within an @autoRoute scope, generate the path.  This
    // mutates the pathFragments and parameters lists that are passed in!
    generatePathFromParameters(program, operation, pathFragments, parameters, options);
  } else {
    // Prepend any explicit route path
    if (routePath) {
      pathFragments.push(routePath.path);
    }

    // Pull out path parameters to verify what's in the path string
    const paramByName = new Map(
      parameters.parameters
        .filter(({ type }) => type === "path")
        .map(({ param }) => [param.name, param])
    );

    // Find path parameter names used in all route fragments
    const declaredPathParams = pathFragments.flatMap(extractParamsFromPath);

    // For each param in the declared path parameters (e.g. /foo/{id} has one, id),
    // delete it because it doesn't need to be added to the path.
    for (const declaredParam of declaredPathParams) {
      const param = paramByName.get(declaredParam);
      if (!param) {
        diagnostics.add(
          createDiagnostic({
            code: "missing-path-param",
            format: { param: declaredParam },
            target: operation,
          })
        );
        continue;
      }

      paramByName.delete(declaredParam);
    }

    // Add any remaining declared path params
    for (const param of paramByName.keys()) {
      pathFragments.push(`{${param}}`);
    }
  }

  return {
    path: buildPath(pathFragments),
    pathFragment: routePath?.path,
    parameters,
  };
}

function getVerbForOperation(program: Program, operation: Operation): HttpVerb | undefined {  const resourceOperation = getResourceOperation(program, operation);
  const verb =
    (resourceOperation && resourceOperationToVerb[resourceOperation.operation]) ??
    getOperationVerb(program, operation) ??
    // TODO: Enable this verb choice to be customized!
    (getAction(program, operation) || getCollectionAction(program, operation) ? "post" : undefined);

    return verb;
}

function buildRoutes(
  program: Program,
  diagnostics: DiagnosticCollector,
  container: OperationContainer,
  routeFragments: string[],
  visitedOperations: Set<Operation>,
  options: RouteOptions
): OperationDetails[] {
  if (container.kind === "Interface" && isTemplateDeclaration(container)) {
    // Skip template interface operations
    return [];
  }
  // Get the route info for this container, if any
  const baseRoute = getRoutePath(program, container);
  const parentFragments = [...routeFragments, ...(baseRoute ? [baseRoute.path] : [])];

  // TODO: Allow overriding the existing resource operation of the same kind
  const operations: OperationDetails[] = [];
  for (const [_, op] of container.operations) {
    // Skip previously-visited operations
    if (visitedOperations.has(op)) {
      continue;
    }

    // Skip templated operations
    if (isTemplateDeclarationOrInstance(op)) {
      continue;
    }

    const verb = getVerbForOperation(program, op);

    const route = getPathForOperation(
      program,
      diagnostics,
      op,
      parentFragments,
      verb ?? "get",
      options
    );

    const responses = diagnostics.pipe(getResponsesForOperation(program, op));

    operations.push({
      path: route.path,
      pathFragment: route.pathFragment,
      verb: verb ?? (route.parameters.bodyType ? "post" : "get"),
      container,
      parameters: route.parameters,
      operation: op,
      responses,
    });
  }

  // Build all child routes and append them to the list, but don't recurse in
  // the global scope because that could pull in unwanted operations
  if (container.kind === "Namespace") {
    // If building routes for the global namespace we shouldn't navigate the sub namespaces.
    const includeSubNamespaces = isGlobalNamespace(program, container);
    const additionalInterfaces = getExternalInterfaces(program, container) ?? [];
    const children: OperationContainer[] = [
      ...(includeSubNamespaces ? [] : container.namespaces.values()),
      ...container.interfaces.values(),
      ...additionalInterfaces,
    ];

    const childRoutes = children.flatMap((child) =>
      buildRoutes(program, diagnostics, child, parentFragments, visitedOperations, options)
    );
    for (const child of childRoutes) [operations.push(child)];
  }

  return operations;
}

export function getRoutesForContainer(
  program: Program,
  container: OperationContainer,
  visitedOperations: Set<Operation>,
  options?: RouteOptions
): [OperationDetails[], readonly Diagnostic[]] {
  const routeOptions =
    options ??
    (container.kind === "Namespace" ? getRouteOptionsForNamespace(program, container) : {}) ??
    {};
  const diagnostics = createDiagnosticCollector();

  return diagnostics.wrap(
    buildRoutes(program, diagnostics, container, [], visitedOperations, routeOptions)
  );
}

const externalInterfaces = createStateSymbol("externalInterfaces");
/**
 * @depreacted DO NOT USE. For internal use only as a workaround.
 * @param program Program
 * @param target Target namespace
 * @param interf Interface that should be included in namespace.
 */
export function includeInterfaceRoutesInNamespace(
  program: Program,
  target: Namespace,
  sourceInterface: string
) {
  let array = program.stateMap(externalInterfaces).get(target);
  if (array === undefined) {
    array = [];
    program.stateMap(externalInterfaces).set(target, array);
  }

  array.push(sourceInterface);
}

function getExternalInterfaces(program: Program, namespace: Namespace) {
  const interfaces: string[] | undefined = program.stateMap(externalInterfaces).get(namespace);
  if (interfaces === undefined) {
    return undefined;
  }
  return interfaces
    .map((interfaceFQN: string) => {
      let current: Namespace | undefined = program.getGlobalNamespaceType();
      const namespaces = interfaceFQN.split(".");
      const interfaceName = namespaces.pop()!;
      for (const namespaceName of namespaces) {
        current = current?.namespaces.get(namespaceName);
      }
      return current?.interfaces.get(interfaceName);
    })
    .filter((x): x is Interface => x !== undefined);
}

export function getAllRoutes(
  program: Program,
  options?: RouteOptions
): [OperationDetails[], readonly Diagnostic[]] {
  let operations: OperationDetails[] = [];
  const diagnostics = createDiagnosticCollector();
  const serviceNamespace = getServiceNamespace(program);
  const namespacesToExport: Namespace[] = serviceNamespace ? [serviceNamespace] : [];

  const visitedOperations = new Set<Operation>();
  for (const container of namespacesToExport) {
    const newOps = diagnostics.pipe(
      getRoutesForContainer(program, container, visitedOperations, options)
    );

    // Make sure we don't visit the same operations again
    newOps.forEach((o) => visitedOperations.add(o.operation));

    // Accumulate the new operations
    operations = [...operations, ...newOps];
  }

  validateRouteUnique(diagnostics, operations);
  return diagnostics.wrap(operations);
}

export function reportIfNoRoutes(program: Program, routes: OperationDetails[]) {
  if (routes.length === 0) {
    reportDiagnostic(program, {
      code: "no-routes",
      target: program.getGlobalNamespaceType(),
    });
  }
}

function validateRouteUnique(diagnostics: DiagnosticCollector, operations: OperationDetails[]) {
  const grouped = new Map<string, Map<HttpVerb, OperationDetails[]>>();

  for (const operation of operations) {
    const { verb, path } = operation;
    let map = grouped.get(path);
    if (map === undefined) {
      map = new Map<HttpVerb, OperationDetails[]>();
      grouped.set(path, map);
    }

    let list = map.get(verb);
    if (list === undefined) {
      list = [];
      map.set(verb, list);
    }

    list.push(operation);
  }

  for (const [path, map] of grouped) {
    for (const [verb, routes] of map) {
      if (routes.length >= 2) {
        for (const route of routes) {
          diagnostics.add(
            createDiagnostic({
              code: "duplicate-operation",
              format: { path, verb, operationName: route.operation.name },
              target: route.operation,
            })
          );
        }
      }
    }
  }
}

// TODO: Make this overridable by libraries
const resourceOperationToVerb: any = {
  read: "get",
  create: "post",
  createOrUpdate: "patch",
  createOrReplace: "put",
  update: "patch",
  delete: "delete",
  list: "get",
};

const autoRouteKey = createStateSymbol("autoRoute");

/**
 * `@autoRoute` enables automatic route generation for an operation, namespace, or interface.
 *
 * When applied to an operation, it automatically generates the operation's route based on path parameter
 * metadata.  When applied to a namespace or interface, it causes all operations under that scope to have
 * auto-generated routes.
 */
export function $autoRoute(context: DecoratorContext, entity: Type) {
  if (
    !validateDecoratorTarget(context, entity, "@autoRoute", ["Namespace", "Interface", "Operation"])
  ) {
    return;
  }

  context.program.stateSet(autoRouteKey).add(entity);
}

export function isAutoRoute(program: Program, target: Namespace | Interface | Operation): boolean {
  // Loop up through parent scopes (interface, namespace) to see if
  // @autoRoute was used anywhere
  let current: Namespace | Interface | Operation | undefined = target;
  while (current !== undefined) {
    if (program.stateSet(autoRouteKey).has(current)) {
      return true;
    }

    // Navigate up to the parent scope
    if (current.kind === "Namespace" || current.kind === "Interface") {
      current = current.namespace;
    } else if (current.kind === "Operation") {
      current = current.interface || current.namespace;
    }
  }

  return false;
}
