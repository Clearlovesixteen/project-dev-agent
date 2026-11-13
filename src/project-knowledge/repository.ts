import { createHash } from "node:crypto";
import { AppError } from "../domain/error.js";
import { ObjectEnvelopeSchema, OperationRecordSchema, SnapshotPointerSchema, TransactionRecordSchema, type ObjectEnvelope, type OperationRecord, type SnapshotPointer, type TransactionRecord } from "./contracts.js";
import { RepositoryFiles } from "./repository-files.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface PublishInput {
  operation_id: string;
  objects: ObjectEnvelope[];
}

/** 项目库事务门面；调用者在这里提交不可变对象，不能直接改写另一个工作树的模型。 */
export class ProjectKnowledgeRepository {
  private constructor(readonly files: RepositoryFiles, readonly repo_identity: string) {}

  static async open(repoIdentity: string): Promise<ProjectKnowledgeRepository> {
    const files = await RepositoryFiles.open(repoIdentity);
    await files.ensureIdentity(repoIdentity);
    return new ProjectKnowledgeRepository(files, repoIdentity);
  }

  async current(): Promise<SnapshotPointer | undefined> { return this.files.readCurrent(); }

  async publish(input: PublishInput): Promise<{ transaction: TransactionRecord; pointer: SnapshotPointer }> {
    if (!input.operation_id.trim()) throw new AppError("PROJECT_KNOWLEDGE_OPERATION_INVALID", "知识库事务需要 operation_id");
    const objects = input.objects.map((object) => ObjectEnvelopeSchema.parse(object));
    const objectIds = objects.map((object) => object.object_id);
    if (new Set(objectIds).size !== objectIds.length) throw new AppError("PROJECT_KNOWLEDGE_OBJECT_DUPLICATE", "同一事务不能重复提交对象");
    return this.files.withLock(async () => {
      const operationPath = `operations/${digest(input.operation_id)}.json`;
      const existingOperation = await this.files.read(operationPath).catch((error) => {
        if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return undefined;
        throw error;
      });
      if (existingOperation) {
        const operation = OperationRecordSchema.parse(JSON.parse(existingOperation));
        if (operation.operation_id !== input.operation_id || JSON.stringify(operation.object_ids) !== JSON.stringify(objectIds)) {
          throw new AppError("PROJECT_KNOWLEDGE_OPERATION_CONFLICT", "operation_id 已用于另一组知识对象");
        }
        const transaction = await this.readTransaction(operation.transaction_id);
        return { transaction, pointer: transaction.pointer };
      }
      const parent = await this.files.readCurrent();
      if (parent) {
        const parentTransaction = await this.files.read(`transactions/${parent.transaction_id}.json`).catch((error) => {
          if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return undefined;
          throw error;
        });
        if (parentTransaction) {
          const parsed = TransactionRecordSchema.parse(JSON.parse(parentTransaction));
          if (parsed.operation_id === input.operation_id && JSON.stringify(parsed.object_ids) === JSON.stringify(objectIds)) return { transaction: parsed, pointer: parsed.pointer };
        }
      }
      const transactionId = digest(JSON.stringify([parent?.transaction_id ?? null, input.operation_id, objectIds]));
      const pointer: SnapshotPointer = SnapshotPointerSchema.parse({ schema_version: 1, transaction_id: transactionId, object_ids: objectIds, committed_at: new Date().toISOString() });
      const transaction: TransactionRecord = TransactionRecordSchema.parse({ schema_version: 1, transaction_id: transactionId, parent_transaction_id: parent?.transaction_id ?? null, operation_id: input.operation_id, object_ids: objectIds, pointer });
      for (const object of objects) {
        const content = JSON.stringify(object);
        try {
          const existing = await this.files.read(`objects/${object.object_id}.json`);
          if (existing !== content) throw new AppError("PROJECT_KNOWLEDGE_OBJECT_CONFLICT", `对象内容与哈希记录不一致：${object.object_id}`);
        } catch (error) {
          if (!(error instanceof AppError && error.code === "PROJECT_KNOWLEDGE_PATH_UNSAFE") && !(error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error;
          await this.files.create(`objects/${object.object_id}.json`, content);
        }
      }
      // 同一个 operation_id 和相同对象集合重试时，CURRENT 只写入同一个事务。
      const existingTransaction = await this.files.read(`transactions/${transactionId}.json`).catch((error) => {
        if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return undefined;
        throw error;
      });
      if (!existingTransaction) await this.files.create(`transactions/${transactionId}.json`, JSON.stringify(transaction));
      const operation: OperationRecord = OperationRecordSchema.parse({ schema_version: 1, operation_id: input.operation_id, transaction_id: transactionId, object_ids: objectIds });
      await this.files.create(operationPath, JSON.stringify(operation));
      const current = await this.files.read("CURRENT.json").catch((error) => {
        if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return undefined;
        throw error;
      });
      if (!current) await this.files.create("CURRENT.json", JSON.stringify(pointer));
      else {
        const currentPointer = SnapshotPointerSchema.parse(JSON.parse(current));
        if (currentPointer.transaction_id !== transactionId) await this.files.replace("CURRENT.json", JSON.stringify(pointer), current);
      }
      return { transaction, pointer };
    });
  }

  async readObject(objectId: string): Promise<ObjectEnvelope> {
    const raw = await this.files.read(`objects/${objectId}.json`);
    const object = ObjectEnvelopeSchema.parse(JSON.parse(raw));
    if (object.object_id !== objectId) throw new AppError("PROJECT_KNOWLEDGE_OBJECT_CORRUPT", `对象 ID 不匹配：${objectId}`);
    return object;
  }

  async readTransaction(transactionId: string): Promise<TransactionRecord> {
    const raw = await this.files.read(`transactions/${transactionId}.json`);
    const transaction = TransactionRecordSchema.parse(JSON.parse(raw));
    if (transaction.transaction_id !== transactionId) throw new AppError("PROJECT_KNOWLEDGE_TRANSACTION_CORRUPT", `事务 ID 不匹配：${transactionId}`);
    return transaction;
  }

  /** 按父事务从当前状态读取完整对象链；不把 CURRENT 的单批对象误当作全项目模型。 */
  async currentObjectIds(): Promise<string[]> {
    const pointer = await this.current();
    if (!pointer) return [];
    const ids: string[] = [];
    const visited = new Set<string>();
    let transactionId: string | null = pointer.transaction_id;
    while (transactionId) {
      if (visited.has(transactionId)) throw new AppError("PROJECT_KNOWLEDGE_TRANSACTION_CYCLE", "知识库事务链存在循环");
      visited.add(transactionId);
      const transaction = await this.readTransaction(transactionId);
      ids.push(...transaction.object_ids);
      transactionId = transaction.parent_transaction_id;
    }
    return [...new Set(ids)];
  }
}
