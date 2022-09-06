import { deepStrictEqual } from "assert";
import { openApiFor } from "./test-host.js";

describe("openapi3: metadata", () => {
  it("handles cycle in untransformed model", async () => {
    const res = await openApiFor(
      `
      model Thing {
       things: Thing[];
      }

      @route("/")
      @get
      op get(): Thing;
      `
    );

    deepStrictEqual(res.paths, {
      "/": {
        get: {
          operationId: "get",
          parameters: [],
          responses: {
            "200": {
              description: "The request has succeeded.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ThingRead",
                  },
                },
              },
            },
          },
        },
      },
    });
    deepStrictEqual(res.components.schemas, {
      Thing: {
        type: "object",
        properties: {
          things: {
            type: "array",
            items: {
              $ref: "#/components/schemas/ThingReadItem",
            },
            "x-cadl-name": "Thing[]",
          },
        },
        required: ["things"],
      },
    });
  });

  it("handles cycle in transformed model", async () => {
    const res = await openApiFor(
      `
      model Thing {
       @header h1: string;
       things: Thing[];
      }

      @route("/")
      @get
      op get(): Thing;
      `
    );

    deepStrictEqual(res.paths, {
      "/": {
        get: {
          operationId: "get",
          parameters: [],
          responses: {
            "200": {
              description: "The request has succeeded.",
              headers: {
                h1: {
                  schema: {
                    type: "string",
                  },
                },
              },
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ThingRead",
                  },
                },
              },
            },
          },
        },
      },
    });
    deepStrictEqual(res.components.schemas, {
      ThingRead: {
        type: "object",
        properties: {
          things: {
            type: "array",
            items: {
              $ref: "#/components/schemas/ThingReadItem",
            },
            "x-cadl-name": "Thing[]",
          },
        },
        required: ["things"],
      },
      ThingReadItem: {
        type: "object",
        properties: {
          h1: {
            type: "string",
          },
          things: {
            type: "array",
            items: {
              $ref: "#/components/schemas/ThingReadItem",
            },
            "x-cadl-name": "Thing[]",
          },
        },
        required: ["h1", "things"],
      },
    });
  });

  it("supports nested metadata and removes emptied properties", async () => {
    const res = await openApiFor(
      `
      model Pet {
        headers: {
          @header h1: string;
          moreHeaders: {
            @header h2: string;
          }
        };

        @path
        id: string;
        name: string;
      }
      
      @route("/pets")
      @post op create(...Pet): Pet;
      `
    );

    deepStrictEqual(res.paths, {
      "/pets/{id}": {
        post: {
          operationId: "create",
          parameters: [
            {
              $ref: "#/components/parameters/Pet.id",
            },
            {
              name: "h1",
              in: "header",
              required: true,
              schema: {
                type: "string",
              },
            },
            {
              name: "h2",
              in: "header",
              required: true,
              schema: {
                type: "string",
              },
            },
          ],
          responses: {
            "200": {
              description: "The request has succeeded.",
              headers: {
                h1: {
                  schema: {
                    type: "string",
                  },
                },
                h2: {
                  schema: {
                    type: "string",
                  },
                },
              },
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/PetRead",
                  },
                },
              },
            },
          },
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Pet",
                },
              },
            },
          },
        },
      },
    });

    deepStrictEqual(res.components.schemas, {
      Pet: {
        type: "object",
        properties: {
          name: {
            type: "string",
          },
        },
        required: ["name"],
      },
      PetRead: {
        type: "object",
        properties: {
          id: {
            type: "string",
          },
          name: {
            type: "string",
          },
        },
        required: ["id", "name"],
      },
    });
  });
});
