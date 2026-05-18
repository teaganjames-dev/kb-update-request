// netlify/functions/slack-reaction.js
// Listens for ✅ reactions in your Slack approvals channel
//
// For UPDATE requests:
//   → updates ClickUp task status to "UPDATE REQUESTED"
//   → posts description as a comment on the task
//   → posts Slack thread reply confirming
//
// For NEW article requests:
//   → creates a new ClickUp task with the article topic as the name
//   → sets priority on the new task
//   → posts description as a comment on the new task
//   → posts Slack thread reply confirming

const crypto = require('crypto');

const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN;
const CLICKUP_LIST_ID = process.env.CLICKUP_LIST_ID;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const APPROVAL_EMOJI = 'white_check_mark';

const PRIORITY_MAP = { High: 2, Medium: 3, Low: 4 };

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

// Parse all relevant fields from the Slack message context footer
function parseMessage(message) {
  let reqType = null, taskId = null, requester = null, description = null, topic = null, priority = null;

  const blocks = message.blocks || [];
  for (const block of blocks) {
    if (block.type === 'context') {
      for (const el of block.elements || []) {
        const t = el.text || '';
        const typeMatch = t.match(/Type: `([^`]+)`/);
        if (typeMatch) reqType = typeMatch[1];
        const idMatch = t.match(/ClickUp Task ID: `([^`]+)`/);
        if (idMatch) taskId = idMatch[1];
        const topicMatch = t.match(/Topic: `([^`]+)`/);
        if (topicMatch) topic = topicMatch[1];
        const requesterMatch = t.match(/Requested by: `([^`]+)`/);
        if (requesterMatch) requester = requesterMatch[1];
        const priorityMatch = t.match(/Priority: `([^`]+)`/);
        if (priorityMatch) priority = priorityMatch[1];
        const descMatch = t.match(/Description: `([^`]+)`/);
        if (descMatch) description = descMatch[1];
      }
    }
    // Also parse requester from section fields for update requests
    if (block.type === 'section' && block.fields) {
      for (const f of block.fields) {
        const nameMatch = f.text?.match(/\*Requested by:\*\n(.+)/);
        if (nameMatch) requester = nameMatch[1].trim();
      }
    }
    // Parse description from section for update requests
    if (block.type === 'section' && block.text?.text) {
      const descMatch = block.text.text.match(/\*What needs updating:\*\n([\s\S]+)/);
      if (descMatch) description = descMatch[1].trim();
    }
  }

  return { reqType, taskId, requester, description, topic, priority };
}

async function updateClickUpStatus(taskId) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
    method: 'PUT',
    headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'UPDATE REQUESTED' })
  });
  return res.ok;
}

async function createClickUpTask(topic, priority) {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task`, {
    method: 'POST',
    headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: topic,
      priority: PRIORITY_MAP[priority] || 3,
      status: 'NEW ARTICLE'
    })
  });
  const data = await res.json();
  return data.id || null;
}

async function postClickUpComment(taskId, requester, description) {
  await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    method: 'POST',
    headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      comment_text: `📝 Requested by ${requester}:\n\n${description}`
    })
  });
}

async function postThreadReply(channel, ts, approverUserId, message) {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, thread_ts: ts, text: `✅ Approved by <@${approverUserId}> — ${message}` })
  });
}

exports.handler = async (event) => {
  const rawBody = event.body;
  const headers = event.headers;
  const parsed = JSON.parse(rawBody);

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

    const { reqType, taskId, requester, description, topic, priority } = parseMessage(message);

    if (reqType === 'update') {
      if (!taskId) return { statusCode: 200, body: 'Task ID not found' };
      const updated = await updateClickUpStatus(taskId);
      if (!updated) return { statusCode: 500, body: 'ClickUp update failed' };
      if (requester && description) await postClickUpComment(taskId, requester, description);
      await postThreadReply(SLACK_CHANNEL_ID, ts, approverUserId, 'ClickUp task status updated to *UPDATE REQUESTED* and description added as a comment.');

    } else if (reqType === 'new') {
      if (!topic) return { statusCode: 200, body: 'Article topic not found' };
      const newTaskId = await createClickUpTask(topic, priority);
      if (!newTaskId) return { statusCode: 500, body: 'ClickUp task creation failed' };
      if (requester && description) await postClickUpComment(newTaskId, requester, description);
      await postThreadReply(SLACK_CHANNEL_ID, ts, approverUserId, `New ClickUp task created: *${topic}* with description added as a comment.`);

    } else {
      return { statusCode: 200, body: 'Unknown request type' };
    }

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Internal error' };
  }
};
