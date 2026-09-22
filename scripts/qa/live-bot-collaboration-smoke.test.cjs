const assert = require("node:assert/strict");
const test = require("node:test");

const {
  eventType,
  matchingAck,
  matchingReceiverReceipt,
  matchingSenderDelivery,
} = require("./live-bot-collaboration-smoke.cjs");

test("uses timeline legacy types when matching live bot receipts", () => {
  const senderEvent = {
    id: "sender-event",
    type: "timeline_step_updated",
    legacyType: "agent_message",
    timestamp: 10,
    payload: {
      messageId: "message-1",
      targetTaskId: "recipient-task",
      deliveryStatus: "delivered",
    },
  };
  const receiverEvent = {
    id: "receiver-event",
    type: "timeline_step_updated",
    legacyType: "user_message",
    timestamp: 11,
    payload: {
      messageId: "message-1",
      senderTaskId: "sender-task",
      message: "LIVE marker",
      deliveryStatus: "delivered",
    },
  };

  assert.equal(eventType(senderEvent), "agent_message");
  assert.equal(
    matchingSenderDelivery([senderEvent], "message-1", "recipient-task"),
    senderEvent,
  );
  assert.equal(
    matchingReceiverReceipt([receiverEvent], "message-1", "sender-task", "LIVE marker"),
    receiverEvent,
  );
});

test("requires a receiver assistant event for the live acknowledgement proof", () => {
  const ackToken = "COWORK_BOT_ACK_TEST";
  const receiverToolMessage = {
    type: "timeline_step_updated",
    legacyType: "agent_message",
    timestamp: 20,
    payload: { message: ackToken },
  };
  const receiverAssistantMessage = {
    type: "timeline_step_updated",
    legacyType: "assistant_message",
    timestamp: 21,
    payload: { message: ackToken },
  };

  assert.equal(matchingAck([receiverToolMessage], ackToken, 0), undefined);
  assert.equal(matchingAck([receiverToolMessage, receiverAssistantMessage], ackToken, 0), receiverAssistantMessage);
});
