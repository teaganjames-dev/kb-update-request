// netlify/functions/clickup-proxy.js
// Handles two actions:
//   GET  ?action=getTasks      → fetches KB articles from ClickUp for the dropdown
//   POST { action: submitRequest } → sets ClickUp priority + posts Slack message

const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN;
const CLICKUP_LIST_ID = process.env.CLICKUP_LIST_ID;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;

const PRIORITY_MAP = { High: 2, Medium: 3, Low: 4 };

function getPriorityEmoji(p) {
  return p === 'High' ? '🔴' : p === 'Medium' ? '🟡' : '🟢';
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // GET — fetch tasks for dropdown
  if (event.httpMethod === 'GET') {
    const action = event.queryStringParameters?.action;
    if (action !== 'getTasks') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    }
    try {
      const res = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task?limit=100`, {
        headers: { Authorization: CLICKUP_TOKEN }
      });
      const data = await res.json();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ tasks: data.tasks?.map(t => ({ id: t.id, name: t.name })) || [] })
      };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to fetch tasks' }) };
    }
  }

  // POST — set priority on ClickUp + post Slack message
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { action, name, taskId, articleName, description, priority } = body;
    if (action !== 'submitRequest' || !name || !taskId || !articleName || !description || !priority) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    try {
      // 1. Set priority on ClickUp task
      await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
        method: 'PUT',
        headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: PRIORITY_MAP[priority] })
      });

      // 2. Post to Slack
      await fetch(SLACK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `📝 *KB Update Request*`,
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: '📝 KB Update Request', emoji: true } },
            {
              type: 'section',
              fields: [
                { type: 'mrkdwn', text: `*Requested by:*\n${name}` },
                { type: 'mrkdwn', text: `*Priority:*\n${getPriorityEmoji(priority)} ${priority}` }
              ]
            },
            { type: 'section', text: { type: 'mrkdwn', text: `*Article:*\n${articleName}` } },
            { type: 'section', text: { type: 'mrkdwn', text: `*What needs updating:*\n${description}` } },
            { type: 'divider' },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: `React with ✅ to approve · ClickUp Task ID: \`${taskId}\`` }]
            }
          ]
        })
      });

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
