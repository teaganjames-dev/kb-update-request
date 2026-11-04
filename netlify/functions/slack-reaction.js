// netlify/functions/slack-reaction.js
// Listens for ✅ reactions in the approvals channel.
//
// UPDATE requests:
//   → status → "UPDATE REQUESTED", description added as a comment,
//     category owner assigned to the task, Slack thread reply @mentioning the owner
// NEW article requests:
//   → creates a ClickUp task (status "NEW ARTICLE", priority, category, owner assigned),
//     description added as a comment, Slack thread reply @mentioning the owner
//
// The owner's Slack ID and email are read from the Slack message itself
// (clickup-proxy.js is the single source of truth for ownership).
// Failures are reported in the Slack thread instead of failing silently.

const crypto = require('crypto');

const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN;
const CLICKUP_LIST_ID = process.env.CLICKUP_LIST_ID;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const APPROVAL_EMOJI = 'white_check_mark';

const PRIORITY_MAP = { High: 2, Medium: 3, Low: 4 };
const CATEGORY_FIELD_NAME = 'Collection (Intercom)';

const CU = { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' };
const SLACK_AUTH = { Authorization: `Bearer ${SLACK_BOT_TOKEN}` };

const norm = s => String(s || '').toLowerCase().replace(/\s*::\s*/g, '::').replace(/\s+/g, ' ').trim();
const unesc = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ---------- Slack helpers ----------

function verifySlackSignature(headers, rawBody) {
  const timestamp = headers['x-slack-request-timestamp'];
  const slackSig = headers['x-slack-signature'];
  if (!timestamp || !slackSig) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const computed = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`).digest('hex');
  if (computed.length !== slackSig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig));
}

async function getSlackMessage(channel, ts) {
  const res = await fetch(`https://slack.com/api/conversations.history?channel=${channel}&latest=${ts}&limit=1&inclusive=true`, { headers: SLACK_AUTH });
  const data = await res.json();
  return data.messages?.[0] || null;
}

// Has this message already been approved/processed? (prevents duplicate tasks when
// several people react ✅ or Slack redelivers an event)
async function alreadyProcessed(channel, ts) {
  const res = await fetch(`https://slack.com/api/conversations.replies?channel=${channel}&ts=${ts}`, { headers: SLACK_AUTH });
  const data = await res.json();
  if (!data.ok) return false;
  return (data.messages || []).some(m => m.ts !== ts && /✅ Approved by/.test(m.text || ''));
}

async function postThreadReply(channel, ts, text) {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { ...SLACK_AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, thread_ts: ts, text })
  });
}

// Pull everything we need out of the Slack message the form posted
function parseMessage(message) {
  const out = { reqType: null, taskId: null, category: null, ownerEmail: null, ownerSlackId: null,
                requester: null, description: null, topic: null, priority: null };

  for (const block of message.blocks || []) {
    if (block.type === 'context') {
      for (const el of block.elements || []) {
        const t = el.text || '';
        out.reqType    = (t.match(/Type: `([^`]+)`/) || [])[1] || out.reqType;
        out.taskId     = (t.match(/ClickUp Task ID: `([^`]+)`/) || [])[1] || out.taskId;
        out.ownerEmail = (t.match(/Owner: `([^`]+)`/) || [])[1] || out.ownerEmail;
        const cat      = (t.match(/Category: `([^`]+)`/) || [])[1];
        if (cat) out.category = unesc(cat);
      }
    }
    if (block.type === 'section') {
      for (const f of block.fields || []) {
        const t = f.text || '';
        let m;
        if ((m = t.match(/^\*Requested by:\*\n([\s\S]+)/))) out.requester = unesc(m[1].trim());
        if (/^\*Priority:\*/.test(t)) out.priority = (t.match(/High|Medium|Low/) || [])[0] || null;
        if (/^\*Owner:\*/.test(t)) out.ownerSlackId = (t.match(/<@([A-Z0-9]+)>/) || [])[1] || null;
      }
      const t = block.text?.text || '';
      let m;
      if ((m = t.match(/^\*Article Topic:\*\n([\s\S]+)/))) out.topic = unesc(m[1].trim());
      if ((m = t.match(/^\*(?:What needs updating|What should it cover):\*\n([\s\S]+)/))) out.description = unesc(m[1].trim());
    }
  }
  return out;
}

// ---------- ClickUp helpers ----------

let memberCache = null;
async function getClickUpUserId(email) {
  if (!email) return null;
  if (!memberCache) {
    const res = await fetch('https://api.clickup.com/api/v2/team', { headers: CU });
    const data = await res.json();
    memberCache = (data.teams || []).flatMap(t => (t.members || []).map(m => m.user)).filter(Boolean);
  }
  const u = memberCache.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
  return u ? u.id : null;
}

async function getTask(taskId) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, { headers: CU });
  return res.json();
}

async function getCategoryField() {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/field`, { headers: CU });
  const data = await res.json();
  return (data.fields || []).find(f => norm(f.name) === norm(CATEGORY_FIELD_NAME)) || null;
}

async function setStatus(taskId, status) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
    method: 'PUT', headers: CU, body: JSON.stringify({ status })
  });
  return { ok: res.ok, err: res.ok ? null : await res.text() };
}

async function assignTask(taskId, userId) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
    method: 'PUT', headers: CU, body: JSON.stringify({ assignees: { add: [userId] } })
  });
  return { ok: res.ok, err: res.ok ? null : await res.text() };
}

async function postComment(taskId, text) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    method: 'POST', headers: CU, body: JSON.stringify({ comment_text: text })
  });
  return res.ok;
}

// Create the task, degrading gracefully: full → without status → bare minimum.
async function createClickUpTask(topic, priority, extras) {
  const url = `https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task`;
  const base = { name: topic, priority: PRIORITY_MAP[priority] || 3 };
  const attempts = [
    { payload: { ...base, ...extras, status: 'NEW ARTICLE' }, skipped: null },
    { payload: { ...base, ...extras }, skipped: 'the NEW ARTICLE status' },
    { payload: base, skipped: 'the status, owner assignment and category' }
  ];
  const errors = [];
  for (const a of attempts) {
    const res = await fetch(url, { method: 'POST', headers: CU, body: JSON.stringify(a.payload) });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.id) return { id: data.id, skipped: a.skipped, error: errors[0] || null };
    const err = data.err || JSON.stringify(data);
    console.error(`ClickUp create failed (${a.skipped || 'full payload'}):`, res.status, err);
    errors.push(err);
  }
  return { id: null, error: errors.join(' | ') };
}

// ---------- Handler ----------

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

  // Slack redelivers events it thinks timed out; we've already handled (or reported) the first one
  if (headers['x-slack-retry-num']) return { statusCode: 200, body: 'Retry ignored' };

  const slackEvent = parsed.event;
  if (
    slackEvent?.type !== 'reaction_added' ||
    slackEvent?.reaction !== APPROVAL_EMOJI ||
    slackEvent?.item?.channel !== SLACK_CHANNEL_ID
  ) {
    return { statusCode: 200, body: 'Ignored' };
  }

  const { ts } = slackEvent.item;
  const approver = slackEvent.user;

  try {
    const message = await getSlackMessage(SLACK_CHANNEL_ID, ts);
    if (!message) {
      console.log('Exit: message not found', ts);
      return { statusCode: 200, body: 'Message not found' };
    }

    const info = parseMessage(message);
    if (info.reqType !== 'update' && info.reqType !== 'new') {
      console.log('Exit: not a request message. Parsed:', JSON.stringify(info));
      return { statusCode: 200, body: 'Not a request message' };
    }

    if (await alreadyProcessed(SLACK_CHANNEL_ID, ts)) {
      console.log('Exit: already processed', ts);
      return { statusCode: 200, body: 'Already processed' };
    }

    const ownerMention = info.ownerSlackId ? `<@${info.ownerSlackId}>` : null;
    const ownerUserId = await getClickUpUserId(info.ownerEmail);
    const warnings = [];

    // ===== UPDATE =====
    if (info.reqType === 'update') {
      if (!info.taskId) return { statusCode: 200, body: 'Task ID not found' };

      const status = await setStatus(info.taskId, 'UPDATE REQUESTED');
      if (!status.ok) {
        console.error('Status update failed:', status.err);
        await postThreadReply(SLACK_CHANNEL_ID, ts, `⚠️ Approval by <@${approver}> didn't complete: couldn't set the status to UPDATE REQUESTED. ClickUp said: ${status.err}`);
        return { statusCode: 200, body: 'Status update failed' };
      }

      if (info.requester && info.description) {
        const ok = await postComment(info.taskId, `📝 Update requested by ${info.requester}:\n\n${info.description}`);
        if (!ok) warnings.push("couldn't add the description comment");
      }

      let assigned = false;
      if (ownerUserId) {
        const a = await assignTask(info.taskId, ownerUserId);
        assigned = a.ok;
        if (!a.ok) { console.error('Assign failed:', a.err); warnings.push("couldn't assign the owner in ClickUp"); }
      } else if (info.ownerEmail) {
        warnings.push(`couldn't find a ClickUp user for ${info.ownerEmail}`);
      }

      const parts = ['status set to *UPDATE REQUESTED*', 'description added as a comment'];
      if (assigned && ownerMention) parts.push(`assigned to ${ownerMention}`);
      let reply = `✅ Approved by <@${approver}> — ${parts.join(', ')}.`;
      if (ownerMention && !assigned) reply += ` Heads up ${ownerMention}.`;
      if (warnings.length) reply += ` ⚠️ ${warnings.join('; ')}.`;
      await postThreadReply(SLACK_CHANNEL_ID, ts, reply);

    // ===== NEW ARTICLE =====
    } else {
      if (!info.topic) {
        console.log('Exit: article topic not found. Parsed:', JSON.stringify(info));
        return { statusCode: 200, body: 'Article topic not found' };
      }

      // Resolve the category dropdown option id (so the new task gets its category set)
      const extras = {};
      if (info.category) {
        const field = await getCategoryField();
        const opt = field?.type_config?.options?.find(o => norm(o.name ?? o.label) === norm(info.category));
        if (field && opt) extras.custom_fields = [{ id: field.id, value: opt.id }];
        else warnings.push(`couldn't match the category "${info.category}" to the ClickUp dropdown`);
      }
      if (ownerUserId) extras.assignees = [ownerUserId];
      else if (info.ownerEmail) warnings.push(`couldn't find a ClickUp user for ${info.ownerEmail}`);

      const result = await createClickUpTask(info.topic, info.priority, extras);
      if (!result.id) {
        await postThreadReply(SLACK_CHANNEL_ID, ts, `⚠️ Approval by <@${approver}> didn't complete: the ClickUp task was NOT created. ClickUp said: ${result.error}`);
        return { statusCode: 200, body: 'ClickUp task creation failed' };
      }

      if (info.requester && info.description) {
        const ok = await postComment(result.id, `🆕 Requested by ${info.requester}:\n\n${info.description}`);
        if (!ok) warnings.push("couldn't add the description comment");
      }

      const parts = [`created ClickUp task *${info.topic}*`, 'description added as a comment'];
      if (ownerMention && ownerUserId && !result.skipped) parts.push(`assigned to ${ownerMention}`);
      let reply = `✅ Approved by <@${approver}> — ${parts.join(', ')}.`;
      if (result.skipped) reply += ` ⚠️ Couldn't set ${result.skipped} (ClickUp said: ${result.error}), so the task was created without ${result.skipped.startsWith('the NEW') ? 'it' : 'them'}.${ownerMention ? ` ${ownerMention} please check it.` : ''}`;
      if (warnings.length) reply += ` ⚠️ ${warnings.join('; ')}.`;
      await postThreadReply(SLACK_CHANNEL_ID, ts, reply);
    }

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Internal error' };
  }
};
