// netlify/functions/clickup-proxy.js
// GET  ?action=getTasks       → fetches KB articles for the dropdown
// POST { action: submitRequest } → handles both new article and update requests

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
    if (event.queryStringParameters?.action !== 'getTasks') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    }
    try {
      const res = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task?limit=100`, {
        headers: { Authorization: CLICKUP_TOKEN }
      });
      const data = await res.json();
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ tasks: data.tasks?.map(t => ({ id: t.id, name: t.name })) || [] })
      };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to fetch tasks' }) };
    }
  }

  // POST — handle form submission
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { action, reqType, name, taskId, articleName, articleTopic, description, priority } = body;
    if (action !== 'submitRequest') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    try {
      if (reqType === 'update') {
        // Set priority on existing ClickUp task
        await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
          method: 'PUT',
          headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ priority: PRIORITY_MAP[priority] })
        });

        // Post update request to Slack
        await fetch(SLACK_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `📝 KB Update Request`,
            blocks: [
              { type: 'header', text: { type: 'plain_text', text: '📝 KB Article Update Request', emoji: true } },
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
                elements: [{ type: 'mrkdwn', text: `React with ✅ to approve · Type: \`update\` · ClickUp Task ID: \`${taskId}\`` }]
              }
            ]
          })
        });

      } else {
        // New article request — post to Slack only (ClickUp task created on approval)
        await fetch(SLACK_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `🆕 New KB Article Request`,
            blocks: [
              { type: 'header', text: { type: 'plain_text', text: '🆕 New KB Article Request', emoji: true } },
              {
                type: 'section',
                fields: [
                  { type: 'mrkdwn', text: `*Requested by:*\n${name}` },
                  { type: 'mrkdwn', text: `*Priority:*\n${getPriorityEmoji(priority)} ${priority}` }
                ]
              },
              { type: 'section', text: { type: 'mrkdwn', text: `*Article Topic:*\n${articleTopic}` } },
              { type: 'section', text: { type: 'mrkdwn', text: `*What should it cover:*\n${description}` } },
              { type: 'divider' },
              {
                type: 'context',
                elements: [{ type: 'mrkdwn', text: `React with ✅ to approve · Type: \`new\` · Topic: \`${articleTopic}\` · Requested by: \`${name}\` · Priority: \`${priority}\` · Description: \`${description}\`` }]
              }
            ]
          })
        });
      }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
