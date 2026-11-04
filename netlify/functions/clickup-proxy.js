// netlify/functions/clickup-proxy.js
// GET  ?action=getTasks       → all KB articles (for the "update existing" search)
// GET  ?action=getCategories  → options of the "Collection (Intercom)" dropdown (for "new article")
// POST { action: 'submitRequest' } → posts the request to Slack, @mentioning the category owner
//
// THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR WHO OWNS WHICH CATEGORY.
// To change ownership, edit CATEGORY_OWNERS / OWNERS below.

const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN;
const CLICKUP_LIST_ID = process.env.CLICKUP_LIST_ID;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;

const PRIORITY_MAP = { High: 2, Medium: 3, Low: 4 };
const CATEGORY_FIELD_NAME = 'Collection (Intercom)';
const DEFAULT_OWNER = 'teagan'; // used when a category has no owner mapped / isn't set on the task

const OWNERS = {
  gabe:   { name: 'Gabe Dayrit',        slackId: 'U0B7G70R1L5', email: 'gabe@nuvo.com' },
  diana:  { name: "Diana D'Alessandro", slackId: 'U05RMMKRG5U', email: 'diana@nuvo.com' },
  teagan: { name: 'Teagan James',       slackId: 'U098VF32SQ4', email: 'teagan@nuvo.com' }
};

const CATEGORY_OWNERS = {
  gabe: [
    'Buyers::Approvals and Next Steps',
    'Buyers::Business Details',
    'Buyers::Getting Started',
    'Buyers::Ordering',
    'Buyers::Signatures',
    'Buyers::Trade References'
  ],
  diana: [
    'Completing a Trade Reference',
    'Suppliers::Analytics & Monitoring',
    'Suppliers::Application Management',
    'Suppliers::Dashboard and Navigation'
  ],
  teagan: [
    'Frequently Asked Questions',
    'Suppliers::Account Management',
    'Suppliers::Account Management::Analytics & Monitoring',
    'Suppliers::Account Management::Integrations',
    'Suppliers::Vendor Set Up',
    'Trade References'
  ]
};

// Forgiving name matching (case + spacing around "::")
const norm = s => String(s || '').toLowerCase().replace(/\s*::\s*/g, '::').replace(/\s+/g, ' ').trim();

const OWNER_BY_CATEGORY = {};
for (const [key, cats] of Object.entries(CATEGORY_OWNERS)) {
  for (const c of cats) OWNER_BY_CATEGORY[norm(c)] = key;
}

function ownerFor(category) {
  const key = OWNER_BY_CATEGORY[norm(category)];
  const k = key || DEFAULT_OWNER;
  return { key: k, ...OWNERS[k], matched: !!key };
}

// Escape user-supplied text so it can't trigger @channel / links in Slack
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CU = { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' };

function priorityEmoji(p) {
  return p === 'High' ? '🔴' : p === 'Medium' ? '🟡' : '🟢';
}

// Read the dropdown category name off a ClickUp task
function getCategoryFromTask(task) {
  const field = (task.custom_fields || []).find(f => norm(f.name) === norm(CATEGORY_FIELD_NAME));
  if (!field || field.value === undefined || field.value === null) return [];
  const options = field.type_config?.options || [];
  // A "labels" field returns an array of option ids; a plain dropdown returns a single value
  const values = Array.isArray(field.value) ? field.value : [field.value];
  return values
    .map(v => options.find(o => o.id === v || String(o.orderindex) === String(v)))
    .map(opt => (opt ? (opt.name ?? opt.label ?? null) : null))
    .filter(Boolean);
}

async function fetchAllTasks() {
  const all = [];
  for (let page = 0; page < 20; page++) {
    const res = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task?page=${page}`, { headers: CU });
    const data = await res.json();
    const tasks = data.tasks || [];
    if (!tasks.length) break;
    all.push(...tasks.map(t => ({ id: t.id, name: t.name })));
    if (data.last_page || tasks.length < 100) break;
  }
  return all;
}

async function postToSlack(payload) {
  const res = await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Slack rejected the message (${res.status})`);
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // ---------- GET ----------
  if (event.httpMethod === 'GET') {
    const action = event.queryStringParameters?.action;

    if (action === 'getTasks') {
      try {
        return { statusCode: 200, headers, body: JSON.stringify({ tasks: await fetchAllTasks() }) };
      } catch (e) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to fetch tasks' }) };
      }
    }

    if (action === 'getCategories') {
      try {
        const res = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/field`, { headers: CU });
        const data = await res.json();
        const field = (data.fields || []).find(f => norm(f.name) === norm(CATEGORY_FIELD_NAME));
        const categories = (field?.type_config?.options || []).map(o => ({ id: o.id, name: o.name ?? o.label }));
        return { statusCode: 200, headers, body: JSON.stringify({ categories }) };
      } catch (e) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to fetch categories' }) };
      }
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  }

  // ---------- POST ----------
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { action, reqType, name, taskId, articleName, articleTopic, category, description, priority } = body;
    if (action !== 'submitRequest' || !name || !description || !PRIORITY_MAP[priority]) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    try {
      if (reqType === 'update') {
        if (!taskId || !articleName) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing article' }) };
        }

        // Look up the article's category → owner
        const taskRes = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, { headers: CU });
        const task = await taskRes.json();
        const taskCategories = getCategoryFromTask(task); // array: the field can hold several categories
        const mapped = taskCategories.find(c => OWNER_BY_CATEGORY[norm(c)]);
        const owner = ownerFor(mapped || taskCategories[0] || null);
        const taskCategory = taskCategories.join(', ');

        // Set priority on the existing task
        const prioRes = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
          method: 'PUT', headers: CU, body: JSON.stringify({ priority: PRIORITY_MAP[priority] })
        });
        if (!prioRes.ok) console.error('Setting priority failed:', prioRes.status, await prioRes.text());

        const categoryText = (taskCategory ? esc(taskCategory) : 'Not set') +
          (owner.matched ? '' : '\n⚠️ No owner mapped, defaulting to Teagan');

        await postToSlack({
          text: `📝 KB update request for <@${owner.slackId}>`,
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: '📝 KB Article Update Request', emoji: true } },
            { type: 'section', fields: [
              { type: 'mrkdwn', text: `*Requested by:*\n${esc(name)}` },
              { type: 'mrkdwn', text: `*Priority:*\n${priorityEmoji(priority)} ${priority}` }
            ]},
            { type: 'section', text: { type: 'mrkdwn', text: `*Article:*\n${esc(articleName)}` } },
            { type: 'section', fields: [
              { type: 'mrkdwn', text: `*Category:*\n${categoryText}` },
              { type: 'mrkdwn', text: `*Owner:*\n<@${owner.slackId}>` }
            ]},
            { type: 'section', text: { type: 'mrkdwn', text: `*What needs updating:*\n${esc(description.slice(0, 2500))}` } },
            { type: 'divider' },
            { type: 'context', elements: [{ type: 'mrkdwn',
              text: `React with ✅ to approve · Type: \`update\` · ClickUp Task ID: \`${taskId}\` · Owner: \`${owner.email}\`` }] }
          ]
        });

      } else if (reqType === 'new') {
        if (!articleTopic || !category) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing article topic or category' }) };
        }
        const owner = ownerFor(category);
        const categoryText = esc(category) + (owner.matched ? '' : '\n⚠️ No owner mapped, defaulting to Teagan');

        await postToSlack({
          text: `🆕 New KB article request for <@${owner.slackId}>`,
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: '🆕 New KB Article Request', emoji: true } },
            { type: 'section', fields: [
              { type: 'mrkdwn', text: `*Requested by:*\n${esc(name)}` },
              { type: 'mrkdwn', text: `*Priority:*\n${priorityEmoji(priority)} ${priority}` }
            ]},
            { type: 'section', text: { type: 'mrkdwn', text: `*Article Topic:*\n${esc(articleTopic)}` } },
            { type: 'section', fields: [
              { type: 'mrkdwn', text: `*Category:*\n${categoryText}` },
              { type: 'mrkdwn', text: `*Owner:*\n<@${owner.slackId}>` }
            ]},
            { type: 'section', text: { type: 'mrkdwn', text: `*What should it cover:*\n${esc(description.slice(0, 2500))}` } },
            { type: 'divider' },
            { type: 'context', elements: [{ type: 'mrkdwn',
              text: `React with ✅ to approve · Type: \`new\` · Category: \`${esc(category)}\` · Owner: \`${owner.email}\`` }] }
          ]
        });

      } else {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown request type' }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (e) {
      console.error(e);
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
