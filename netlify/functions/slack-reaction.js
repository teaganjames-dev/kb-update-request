// netlify/functions/slack-reaction.js
// Listens for ✅ reactions in the approvals channel.
//
// UPDATE requests:
//   → status → "UPDATE REQUESTED", description added as a comment,
//     category owner assigned to the task, Slack thread reply @mentioning the owner
// NEW article requests:
//   → creates a ClickUp task (NEW ARTICLE status, priority, owner assigned),
//     sets the category, adds the description as a comment,
//     Slack thread reply @mentioning the owner
//
// The owner's Slack ID and email are read from the Slack message itself
// (clickup-proxy.js is the single source of truth for ownership).
// Every step reports its own failure in the Slack thread instead of failing silently.

const crypto = require('crypto');

const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN;
const CLICKUP_LIST_ID = process.env.CLICKUP_LIST_ID;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const APPROVAL_EMOJI = 'white_check_mark';

const PRIORITY_MAP = { High: 2, Medium: 3, Low: 4 };
const CATEGORY_FIELD_NAME = 'Collection (Intercom)';
const NEW_ARTICLE_STATUS = 'NEW ARTICLE';

const CU = { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' };
const SLACK_AUTH = { Authorization: `Bearer ${SLACK_BOT_TOKEN}` };

const norm = s => String(s || '').toLowerCase().replace(/\s*::\s*/g, '::').replace(/\s+/g, ' ').trim();
const loose = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const unesc = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// Slack may return emails wrapped as <mailto:a@b.com|a@b.com>, so pull out just the address
const emailOf = s => (String(s || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0] || null;

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
        out.ownerEmail = emailOf((t.match(/Owner: `([^`]+)`/) || [])[1]) || out.ownerEmail;
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
    console.log(`ClickUp members visible: ${memberCache.length}`,
      memberCache.map(u => `${u.username} <${u.email}>`).join('; '));
  }
  const want = email.toLowerCase();
  let u = memberCache.find(x => (x.email || '').toLowerCase() === want);
  if (!u) {
    // Fallback: same name before the @, accepted only if it's unambiguous
    const local = want.split('@')[0];
    const matches = memberCache.filter(x => (x.email || '').toLowerCase().split('@')[0] === local);
    if (matches.length === 1) u = matches[0];
  }
  return u ? u.id : null;
}

async function getCategoryField() {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/field`, { headers: CU });
  const data = await res.json();
  return (data.fields || []).find(f => norm(f.name) === norm(CATEGORY_FIELD_NAME)) || null;
}

// Find the list's real status name that corresponds to NEW ARTICLE
async function resolveNewArticleStatus() {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}`, { headers: CU });
  const data = await res.json();
  const statuses = (data.statuses || []).map(s => s.status);
  const target = loose(NEW_ARTICLE_STATUS);
  const status = statuses.find(s => loose(s) === target) || statuses.find(s => loose(s).includes(target)) || null;
  return { status, statuses };
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

// Set the category dropdown on a task. ClickUp has accepted both the option id and
// the option's order index, so try the id first and then the index.
async function setCategory(taskId, field, option) {
  const url = `https://api.clickup.com/api/v2/task/${taskId}/field/${field.id}`;
  let lastErr = '';
  // A "labels" field takes an array of option ids; a plain dropdown takes a single value
  const candidates = field.type === 'labels' ? [[option.id]] : [option.id, option.orderindex];
  for (const value of candidates) {
    if (value === undefined || value === null) continue;
    const res = await fetch(url, { method: 'POST', headers: CU, body: JSON.stringify({ value }) });
    if (res.ok) return { ok: true };
    lastErr = await res.text();
    console.error('Set category failed with value', value, res.status, lastErr);
  }
  return { ok: false, err: lastErr };
}

// Create the task, degrading gracefully: full → without status → bare minimum.
// Returns what had to be dropped so the thread reply can say so.
async function createClickUpTask(topic, priority, assigneeId, statusName) {
  const url = `https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task`;
  const base = { name: topic, priority: PRIORITY_MAP[priority] || 3 };

  const combos = [
    { s: true, a: true }, { s: false, a: true }, { s: false, a: false }
  ].filter(c => (!c.s || statusName) && (!c.a || assigneeId));

  const errors = [];
  for (const c of combos) {
    const payload = { ...base };
    if (c.s) payload.status = statusName;
    if (c.a) payload.assignees = [assigneeId];

    const res = await fetch(url, { method: 'POST', headers: CU, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.id) {
      const lost = [];
      if (statusName && !c.s) lost.push('status');
      if (assigneeId && !c.a) lost.push('owner');
      return { id: data.id, lost, errors };
    }
    const err = data.err || JSON.stringify(data);
    console.error('ClickUp create failed:', JSON.stringify(payload), res.status, err);
    errors.push(err);
  }
  return { id: null, lost: [], errors };
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
    if (info.ownerEmail && !ownerUserId) warnings.push(`couldn't find a ClickUp user for ${info.ownerEmail}`);

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

      // Category dropdown option
      let field = null, option = null;
      if (info.category) {
        field = await getCategoryField();
        option = field?.type_config?.options?.find(o => norm(o.name ?? o.label) === norm(info.category)) || null;
        if (!option) warnings.push(`couldn't match the category "${info.category}" to the ClickUp dropdown`);
      }

      // Real name of the NEW ARTICLE status on this list
      const { status: statusName, statuses } = await resolveNewArticleStatus();
      if (!statusName) {
        warnings.push(`no "${NEW_ARTICLE_STATUS}" status found on this list (its statuses: ${statuses.join(', ') || 'none returned'})`);
      }

      const result = await createClickUpTask(info.topic, info.priority, ownerUserId, statusName);
      if (!result.id) {
        await postThreadReply(SLACK_CHANNEL_ID, ts, `⚠️ Approval by <@${approver}> didn't complete: the ClickUp task was NOT created. ClickUp said: ${result.errors.join(' | ')}`);
        return { statusCode: 200, body: 'ClickUp task creation failed' };
      }

      if (result.lost.includes('status')) {
        warnings.push(`couldn't set the status "${statusName}" (ClickUp said: ${result.errors[0]})`);
      }

      // If the owner couldn't be assigned at creation, try once more on its own
      let assigned = !!ownerUserId && !result.lost.includes('owner');
      if (ownerUserId && !assigned) {
        const a = await assignTask(result.id, ownerUserId);
        assigned = a.ok;
        if (!a.ok) warnings.push(`couldn't assign the owner (ClickUp said: ${a.err})`);
      }

      if (option) {
        const c = await setCategory(result.id, field, option);
        if (!c.ok) warnings.push(`couldn't set the category (ClickUp said: ${c.err})`);
      }

      if (info.requester && info.description) {
        const ok = await postComment(result.id, `🆕 Requested by ${info.requester}:\n\n${info.description}`);
        if (!ok) warnings.push("couldn't add the description comment");
      }

      const parts = [`created ClickUp task *${info.topic}*`, 'description added as a comment'];
      if (statusName && !result.lost.includes('status')) parts.push(`status *${statusName}*`);
      if (assigned && ownerMention) parts.push(`assigned to ${ownerMention}`);
      let reply = `✅ Approved by <@${approver}> — ${parts.join(', ')}.`;
      if (warnings.length) reply += ` ⚠️ ${warnings.join('; ')}.${ownerMention ? ` ${ownerMention} please check it.` : ''}`;
      await postThreadReply(SLACK_CHANNEL_ID, ts, reply);
    }

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Internal error' };
  }
};
