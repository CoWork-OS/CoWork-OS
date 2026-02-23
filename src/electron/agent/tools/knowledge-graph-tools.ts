import type { LLMTool } from "../llm/types";
import type { Workspace } from "../../../shared/types";
import type { AgentDaemon } from "../daemon";
import { KnowledgeGraphService } from "../../knowledge-graph/KnowledgeGraphService";

export class KnowledgeGraphTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "kg_create_entity",
        description:
          "Create or update an entity in the workspace knowledge graph. Entities represent people, projects, technologies, services, files, concepts, and other key items. If an entity with the same type and name already exists, it will be updated.",
        input_schema: {
          type: "object",
          properties: {
            entity_type: {
              type: "string",
              description:
                "The type of entity. Built-in types: person, organization, project, technology, concept, file, service, api_endpoint, database_table, environment. You can also use custom types.",
            },
            name: {
              type: "string",
              description: "The name of the entity (e.g. 'React', 'auth-service', 'John Smith')",
            },
            description: {
              type: "string",
              description: "A brief description of the entity",
            },
            properties: {
              type: "object",
              description: "Optional key-value properties for the entity",
            },
          },
          required: ["entity_type", "name"],
        },
      },
      {
        name: "kg_update_entity",
        description:
          "Update an existing entity's description, properties, or confidence score in the knowledge graph.",
        input_schema: {
          type: "object",
          properties: {
            entity_id: {
              type: "string",
              description: "The ID of the entity to update",
            },
            description: {
              type: "string",
              description: "New description for the entity",
            },
            properties: {
              type: "object",
              description: "Updated properties (merged with existing)",
            },
            confidence: {
              type: "number",
              description: "New confidence score (0.0 to 1.0)",
            },
          },
          required: ["entity_id"],
        },
      },
      {
        name: "kg_delete_entity",
        description:
          "Delete an entity and all its relationships and observations from the knowledge graph.",
        input_schema: {
          type: "object",
          properties: {
            entity_id: {
              type: "string",
              description: "The ID of the entity to delete",
            },
          },
          required: ["entity_id"],
        },
      },
      {
        name: "kg_create_edge",
        description:
          "Create a typed relationship (edge) between two entities in the knowledge graph. Common edge types: uses, depends_on, part_of, created_by, maintained_by, deployed_to, connects_to, extends, implements, references, owns, belongs_to, related_to, blocked_by, replaced_by.",
        input_schema: {
          type: "object",
          properties: {
            source_entity_id: {
              type: "string",
              description: "The ID of the source entity",
            },
            target_entity_id: {
              type: "string",
              description: "The ID of the target entity",
            },
            edge_type: {
              type: "string",
              description: "The type of relationship (e.g. 'uses', 'depends_on', 'part_of')",
            },
            properties: {
              type: "object",
              description: "Optional metadata for the relationship",
            },
          },
          required: ["source_entity_id", "target_entity_id", "edge_type"],
        },
      },
      {
        name: "kg_delete_edge",
        description: "Delete a relationship (edge) from the knowledge graph.",
        input_schema: {
          type: "object",
          properties: {
            edge_id: {
              type: "string",
              description: "The ID of the edge to delete",
            },
          },
          required: ["edge_id"],
        },
      },
      {
        name: "kg_add_observation",
        description:
          "Add a timestamped observation or fact to an entity. Observations are append-only notes that track changes, discoveries, or context over time.",
        input_schema: {
          type: "object",
          properties: {
            entity_id: {
              type: "string",
              description: "The ID of the entity to add the observation to",
            },
            content: {
              type: "string",
              description:
                "The observation text (e.g. 'Upgraded from v2 to v3', 'Experiencing high latency')",
            },
          },
          required: ["entity_id", "content"],
        },
      },
      {
        name: "kg_search",
        description:
          "Search for entities in the knowledge graph by name or description. Uses full-text search with ranking.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query (matched against entity names and descriptions)",
            },
            entity_type: {
              type: "string",
              description: "Optional: filter results to a specific entity type",
            },
            limit: {
              type: "number",
              description: "Maximum number of results (default: 10, max: 50)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "kg_get_neighbors",
        description:
          "Get entities connected to a given entity via relationships. Supports multi-hop traversal up to 3 hops deep.",
        input_schema: {
          type: "object",
          properties: {
            entity_id: {
              type: "string",
              description: "The ID of the entity to get neighbors for",
            },
            depth: {
              type: "number",
              description: "How many hops to traverse (1-3, default: 1)",
            },
            edge_types: {
              type: "array",
              items: { type: "string" },
              description: "Optional: filter by specific edge types",
            },
          },
          required: ["entity_id"],
        },
      },
      {
        name: "kg_get_subgraph",
        description:
          "Get a subgraph containing specified entities and all edges between them. Useful for understanding how a set of entities relate to each other.",
        input_schema: {
          type: "object",
          properties: {
            entity_ids: {
              type: "array",
              items: { type: "string" },
              description: "List of entity IDs to include in the subgraph",
            },
          },
          required: ["entity_ids"],
        },
      },
    ];
  }

  static isKnowledgeGraphTool(name: string): boolean {
    return name.startsWith("kg_");
  }

  async executeTool(name: string, input: any): Promise<any> {
    if (!KnowledgeGraphService.isInitialized()) {
      return { error: "Knowledge graph not initialized" };
    }

    switch (name) {
      case "kg_create_entity":
        return this.createEntity(input);
      case "kg_update_entity":
        return this.updateEntity(input);
      case "kg_delete_entity":
        return this.deleteEntity(input);
      case "kg_create_edge":
        return this.createEdge(input);
      case "kg_delete_edge":
        return this.deleteEdge(input);
      case "kg_add_observation":
        return this.addObservation(input);
      case "kg_search":
        return this.searchEntities(input);
      case "kg_get_neighbors":
        return this.getNeighbors(input);
      case "kg_get_subgraph":
        return this.getSubgraph(input);
      default:
        throw new Error(`Unknown knowledge graph tool: ${name}`);
    }
  }

  private createEntity(input: any): any {
    const entity = KnowledgeGraphService.createEntity(
      this.workspace.id,
      {
        entityType: input.entity_type,
        name: input.name,
        description: input.description,
        properties: input.properties,
      },
      "agent",
      this.taskId,
    );
    return {
      success: true,
      entity: {
        id: entity.id,
        type: entity.entityTypeName || input.entity_type,
        name: entity.name,
        description: entity.description,
        confidence: entity.confidence,
      },
    };
  }

  private updateEntity(input: any): any {
    const entity = KnowledgeGraphService.updateEntity({
      entityId: input.entity_id,
      description: input.description,
      properties: input.properties,
      confidence: input.confidence,
    });
    if (!entity) {
      return { error: `Entity not found: ${input.entity_id}` };
    }
    return {
      success: true,
      entity: {
        id: entity.id,
        name: entity.name,
        description: entity.description,
        confidence: entity.confidence,
      },
    };
  }

  private deleteEntity(input: any): any {
    const deleted = KnowledgeGraphService.deleteEntity(input.entity_id);
    return { success: deleted, message: deleted ? "Entity deleted" : "Entity not found" };
  }

  private createEdge(input: any): any {
    try {
      const edge = KnowledgeGraphService.createEdge(
        this.workspace.id,
        {
          sourceEntityId: input.source_entity_id,
          targetEntityId: input.target_entity_id,
          edgeType: input.edge_type,
          properties: input.properties,
        },
        "agent",
        this.taskId,
      );
      return {
        success: true,
        edge: {
          id: edge.id,
          type: edge.edgeType,
          source: edge.sourceEntityId,
          target: edge.targetEntityId,
        },
      };
    } catch (error: any) {
      return { error: error.message || "Failed to create edge" };
    }
  }

  private deleteEdge(input: any): any {
    const deleted = KnowledgeGraphService.deleteEdge(input.edge_id);
    return { success: deleted, message: deleted ? "Edge deleted" : "Edge not found" };
  }

  private addObservation(input: any): any {
    try {
      const observation = KnowledgeGraphService.addObservation(
        { entityId: input.entity_id, content: input.content },
        "agent",
        this.taskId,
      );
      return {
        success: true,
        observation: {
          id: observation.id,
          entityId: observation.entityId,
          content: observation.content,
          createdAt: observation.createdAt,
        },
      };
    } catch (error: any) {
      return { error: error.message || "Failed to add observation" };
    }
  }

  private searchEntities(input: any): any {
    const limit = Math.min(Math.max(1, input.limit || 10), 50);
    let results = KnowledgeGraphService.search(this.workspace.id, input.query, limit);

    // Filter by entity type if specified
    if (input.entity_type) {
      const typeLower = input.entity_type.toLowerCase().trim();
      results = results.filter((r) => r.entity.entityTypeName === typeLower);
    }

    return {
      results: results.map((r) => ({
        id: r.entity.id,
        type: r.entity.entityTypeName,
        name: r.entity.name,
        description: r.entity.description,
        confidence: r.entity.confidence,
        score: r.score,
      })),
      count: results.length,
    };
  }

  private getNeighbors(input: any): any {
    const depth = Math.min(Math.max(1, input.depth || 1), 3);
    const neighbors = KnowledgeGraphService.getNeighbors(input.entity_id, depth, input.edge_types);

    return {
      neighbors: neighbors.map((n) => ({
        entity: {
          id: n.entity.id,
          type: n.entity.entityTypeName,
          name: n.entity.name,
          description: n.entity.description,
        },
        edge: {
          id: n.edge.id,
          type: n.edge.edgeType,
          direction: n.direction,
        },
        depth: n.depth,
      })),
      count: neighbors.length,
    };
  }

  private getSubgraph(input: any): any {
    const subgraph = KnowledgeGraphService.getSubgraph(input.entity_ids || []);

    return {
      entities: subgraph.entities.map((e) => ({
        id: e.id,
        type: e.entityTypeName,
        name: e.name,
        description: e.description,
        confidence: e.confidence,
      })),
      edges: subgraph.edges.map((e) => ({
        id: e.id,
        type: e.edgeType,
        source: e.sourceEntityId,
        target: e.targetEntityId,
      })),
      entityCount: subgraph.entities.length,
      edgeCount: subgraph.edges.length,
    };
  }
}
