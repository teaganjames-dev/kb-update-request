// netlify/functions/slack-reaction.js
// Listens for ✅ reactions in your Slack approvals channel
// → updates the ClickUp task status to "UPDATE REQUESTED"
// → posts a confirmation reply in the Slack thread

const crypto = require('crypto');

const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const APPROVAL_EMOJI = 'white_check_mark'; // ✅

function verifySlackSignature(headers, rawBody) {
  const timestamp = headers['x-slack-request-timestamp'];
  const slackSig = headers['x-slack-signature'];
  if (!timestamp || !slackSig) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const sigBase = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', SLACK_SIGNING_SECRET);
  const computed = 'v0=' + hmac.update(sigBase).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig));
}

async function getSlackMessage(channel, ts) {
  const res = await fetch(`https://slack.com/api/conversations.history?channel=${channel}&latest=${ts}&limit=1&inclusive=true`, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
  });
  const data = await res.json();
  return data.messages?.[0] || null;
}

function extractTaskId(message) {
  const blocks = message.blocks || [];
  for (const block of blocks) {
    if (block.type === 'context') {
      for (const el of block.elements || []) {
        const match = el.text?.match(/ClickUp Task ID: `([^`]+)`/);
        if (match) return match[1];
      }
    }
  }
  const match = message.text?.match(/ClickUp Task ID: `([^`]+)`/);
  return match ? match[1] : null;
}

async function updateClickUpStatus(taskId) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
    method: 'PUT',
    headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'UPDATE REQUESTED' })
  });
  return res.ok;
}

async function postThreadReply(channel, ts, approverUserId) {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel,
      thread_ts: ts,
      text: `✅ Approved by <@${approverUserId}> — ClickUp task status updated to *UPDATE REQUESTED*.`
    })
  });
}

exports.handler = async (event) => {
  const rawBody = event.body;
  const headers = event.headers;

  const parsed = JSON.parse(rawBody);

  // One-time Slack URL verification challenge
  if (parsed.type === 'url_verification') {
    return { statusCode: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
  }

  if (!verifySlackSignature(headers, rawBody)) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const { event: slackEvent } = parsed;

  if (
    slackEvent?.type !== 'reaction_added' ||
    slackEvent?.reaction !== APPROVAL_EMOJI ||
    slackEvent?.item?.channel !== SLACK_CHANNEL_ID
  ) {
    return { statusCode: 200, body: 'Ignored' };
  }

  const { ts } = slackEvent.item;
  const approverUserId = slackEvent.user;

  try {
    const message = await getSlackMessage(SLACK_CHANNEL_ID, ts);
    if (!message) return { statusCode: 200, body: 'Message not found' };

    const taskId = extractTaskId(message);
    if (!taskId) return { statusCode: 200, body: 'Task ID not found in message' };

    const updated = await updateClickUpStatus(taskId);
    if (!updated) return { statusCode: 500, body: 'ClickUp update failed' };

    await postThreadReply(SLACK_CHANNEL_ID, ts, approverUserId);

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Internal error' };
  }
};
