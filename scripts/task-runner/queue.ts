import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { taskRunnerMcpPath } from "../../packages/core/src/cli-auth.ts";
import { Schema } from "effect";
import { ItemId, Tag, tagNameKey } from "../../apps/web/src/items-contract.ts";
import {
  TaskAttachment,
  taskAttachmentLimit,
} from "../../apps/web/src/task-attachment-contract.ts";
import { Task } from "../../apps/web/src/tasks-contract.ts";
import type {
  TaskRunClaim,
  TaskRunUpdate,
} from "../../apps/web/src/task-run-contract.ts";

const TaskPage = Schema.Struct({
  tasks: Schema.Array(Schema.Struct({ id: ItemId })),
});
const TagPage = Schema.Struct({
  tags: Schema.Array(Tag),
  nextOffset: Schema.NullOr(Schema.Int),
});
const TaskDetails = Schema.Struct({
  task: Schema.Struct({
    ...Task.fields,
    author: Schema.optionalKey(Task.fields.author),
    assignee: Schema.optionalKey(Task.fields.assignee),
    attachments: Schema.Array(TaskAttachment),
  }),
});
const Receipt = Schema.Struct({ id: ItemId, revision: ItemId });
const Claim = Schema.Struct({ revision: Schema.NullOr(ItemId) });
const RunReceipt = Schema.Struct({
  status: Schema.Literals(["updated", "stale", "completion-skipped"]),
});
const readyTag = "ready";

export class TaskQueue {
  private readonly client = new Client({
    name: "Orumai task runner",
    version: "1.0.0",
  });

  constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly signal: AbortSignal,
  ) {}

  async connect() {
    const transport = new StreamableHTTPClientTransport(
      new URL(taskRunnerMcpPath, this.origin),
      {
        requestInit: {
          headers: { authorization: `Bearer ${this.token}` },
          credentials: "omit",
          redirect: "error",
        },
      },
    );
    await this.client.connect(transport, {
      timeout: 15_000,
      signal: this.signal,
    });
  }

  close() {
    return this.client.close();
  }

  private call(name: string, args: Record<string, unknown>) {
    return this.client.callTool(
      { name, arguments: args },
      { timeout: 15_000, signal: this.signal },
    );
  }

  private async read<A>(
    schema: Schema.Decoder<A>,
    name: string,
    args: Record<string, unknown>,
  ) {
    const result = await this.call(name, args);
    if (result.isError) throw new Error(`MCP ${name} failed.`);
    return Schema.decodeUnknownSync(schema)(result.structuredContent);
  }

  private async findReadyTag() {
    let offset: number | null = 0;
    while (offset !== null) {
      const page: typeof TagPage.Type = await this.read(TagPage, "list_tags", {
        query: readyTag,
        limit: 100,
        offset,
      });
      const tag = page.tags.find(({ name }) => tagNameKey(name) === readyTag);
      if (tag) return tag;
      if (page.nextOffset !== null && page.nextOffset <= offset)
        throw new Error("MCP returned an invalid tag page offset.");
      offset = page.nextOffset;
    }
  }

  async next() {
    const tag = await this.findReadyTag();
    if (tag) {
      const { tasks } = await this.read(TaskPage, "list_tasks", {
        status: "not-started",
        tagId: tag.id,
        limit: 1,
      });
      const first = tasks[0];
      if (first)
        return { id: first.id, source: "ready-tag" as const, tagId: tag.id };
    }

    const { tasks } = await this.read(TaskPage, "list_tasks", {
      status: "not-started",
      assignee: "oru",
      limit: 1,
    });
    const first = tasks[0];
    if (first) return { id: first.id, source: "assignment" as const };
  }

  async get(id: string) {
    const { task } = await this.read(TaskDetails, "get_task", { id });
    if (task.id !== id) throw new Error("MCP returned a different task ID.");
    return task;
  }

  async claim(
    taskId: string,
    revision: string,
    runId: string,
    source: typeof TaskRunClaim.Type.source = "ready-tag",
  ) {
    const claim = await this.read(Claim, "claim_task_run", {
      taskId,
      revision,
      runId,
      source,
    });
    return claim.revision ?? undefined;
  }

  async report(taskId: string, runId: string, update: TaskRunUpdate) {
    const receipt = await this.read(RunReceipt, "update_task_run", {
      taskId,
      runId,
      update,
    });
    return receipt.status;
  }

  async complete(id: string, revision: string) {
    const current = await this.get(id);
    if (current.status === "completed") return "completed";
    if (current.revision !== revision || current.status !== "in-progress")
      return "changed";
    const result = await this.call("update_task", {
      id,
      revision,
      status: "completed",
    });
    if (result.isError) {
      const current = await this.get(id);
      if (current.revision !== revision) return "changed";
      throw new Error("MCP could not set task status to completed.");
    }
    const receipt = Schema.decodeUnknownSync(Receipt)(result.structuredContent);
    if (receipt.id !== id || receipt.revision === revision)
      throw new Error("MCP returned an unexpected task update receipt.");
    return "completed";
  }

  async screenshot(taskId: string, attachment: typeof TaskAttachment.Type) {
    const result = await this.call("get_task_attachment", {
      taskId,
      attachmentId: attachment.id,
    });
    const image = result.content.find((part) => part.type === "image");
    if (
      result.isError ||
      !image ||
      image.mimeType !== attachment.mediaType ||
      image.data.length > Math.ceil(taskAttachmentLimit / 3) * 4
    )
      throw new Error("MCP could not read a task screenshot.");
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length !== attachment.size)
      throw new Error("MCP returned an incomplete task screenshot.");
    return bytes;
  }
}
