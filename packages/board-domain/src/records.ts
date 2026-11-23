/* oxlint-disable eslint/max-classes-per-file, eslint/no-redeclare -- Rejections and Schema types share the board record vocabulary. */
import { Rejection } from "@alchemy.run/domain";
import { Schema } from "effect";

export const Did = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^did:[a-z0-9]+:[a-zA-Z0-9._%:-]*[a-zA-Z0-9._%-]$/u)
).pipe(Schema.brand("BoardDid"));

export type Did = typeof Did.Type;

const RecordKey = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._~-]{0,127}$/u)
);

export const ChannelId = RecordKey.pipe(Schema.brand("ChannelId"));

export type ChannelId = typeof ChannelId.Type;

export const MessageId = RecordKey.pipe(Schema.brand("MessageId"));

export type MessageId = typeof MessageId.Type;

export const ThreadKey = Schema.TemplateLiteral([ChannelId, "/", MessageId]);

export const TaskId = ThreadKey.pipe(Schema.brand("TaskId"));

export type TaskId = typeof TaskId.Type;

export const threadKey = (
  channel: ChannelId,
  thread: MessageId
): typeof ThreadKey.Type => `${channel}/${thread}`;

export const taskIdFor = (channel: ChannelId, thread: MessageId): TaskId =>
  TaskId.make(threadKey(channel, thread));

export const TaskStateLabel = "board.task";

export const Text = Schema.NonEmptyString.check(Schema.isMaxLength(16_384));

export const Name = Schema.NonEmptyString.check(Schema.isMaxLength(128));

export const Epoch = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const Claim = Schema.Struct({
  epoch: Epoch,
  holder: Did,
  until: Schema.Int,
});

export type Claim = typeof Claim.Type;

export class NotGranted extends Rejection("NotGranted", { actor: Did }) {}

export class UnknownChannel extends Rejection("UnknownChannel", {}) {}

export class ChannelExists extends Rejection("ChannelExists", {}) {}

export class MessageExists extends Rejection("MessageExists", {
  message: MessageId,
}) {}

export class UnknownMessage extends Rejection("UnknownMessage", {
  message: MessageId,
}) {}

export class LeaseHeld extends Rejection("LeaseHeld", { claim: Claim }) {}

export const ClaimDigest = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u)
).pipe(Schema.brand("ClaimDigest"));

export type ClaimDigest = typeof ClaimDigest.Type;

export class ClaimLost extends Rejection("ClaimLost", {
  reason: Schema.Literals(["StaleEpoch", "Expired", "CredentialMismatch"]),
}) {}

export class ReservedLabel extends Rejection("ReservedLabel", {}) {}

export class InvalidTaskThread extends Rejection("InvalidTaskThread", {}) {}

export class DependencyUnmet extends Rejection("DependencyUnmet", {
  remaining: Schema.Array(TaskId),
}) {}

export class TaskClosed extends Rejection("TaskClosed", {}) {}

export class TaskExists extends Rejection("TaskExists", {}) {}

export class UnknownTask extends Rejection("UnknownTask", {}) {}

export class TaskBlocked extends Rejection("TaskBlocked", { reason: Text }) {}

export class SelfDependency extends Rejection("SelfDependency", {}) {}
