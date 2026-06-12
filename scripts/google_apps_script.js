/**
 * AI News Radar - Google Workspace Email Automation (Google Sheets Database Edition)
 * 
 * Instructions:
 * 1. Open https://script.google.com and create a new project.
 * 2. Delete any existing code in Code.gs and paste this code.
 * 3. Open Project Settings (gear icon) and add the following Script Properties:
 *    - GITHUB_PAGES_URL: The URL of your deployed AI News Radar page (e.g. https://yourusername.github.io/ai-news-radar)
 *    - RECIPIENT_EMAILS: Comma-separated list of emails to receive the alerts (e.g. user@gmail.com)
 *    - EMAIL_SUBJECT_PREFIX: [AI News Radar]
 *    - WEBHOOK_TOKEN: A secret string for webhook authentication (optional, e.g. my-super-secret-token)
 * 4. Save and configure time-based triggers.
 */

// Initialize configurations from Script Properties
function getConfigs() {
  const properties = PropertiesService.getScriptProperties();
  const config = {
    githubPagesUrl: properties.getProperty('GITHUB_PAGES_URL') || '',
    recipientEmails: properties.getProperty('RECIPIENT_EMAILS') || '',
    subjectPrefix: properties.getProperty('EMAIL_SUBJECT_PREFIX') || '[AI News Radar]',
    webhookToken: properties.getProperty('WEBHOOK_TOKEN') || ''
  };
  
  // Clean trailing slashes
  if (config.githubPagesUrl) {
    config.githubPagesUrl = config.githubPagesUrl.replace(/\/$/, '');
  }
  
  return config;
}

/**
 * Locate or automatically create the Google Sheet database in Drive
 */
function getOrCreateSpreadsheet() {
  const properties = PropertiesService.getScriptProperties();
  let sheetId = properties.getProperty('SPREADSHEET_ID');
  let ss;
  
  if (sheetId) {
    try {
      ss = SpreadsheetApp.openById(sheetId);
    } catch (e) {
      console.warn('Could not open spreadsheet by ID, searching by name next.', e.toString());
    }
  }
  
  if (!ss) {
    const files = DriveApp.getFilesByName('AI News Radar Database');
    if (files.hasNext()) {
      ss = SpreadsheetApp.open(files.next());
      properties.setProperty('SPREADSHEET_ID', ss.getId());
      console.log(`Found existing spreadsheet by name: ${ss.getName()} (ID: ${ss.getId()})`);
    } else {
      ss = SpreadsheetApp.create('AI News Radar Database');
      properties.setProperty('SPREADSHEET_ID', ss.getId());
      console.log(`Created new spreadsheet: AI News Radar Database (ID: ${ss.getId()})`);
      
      // Setup initial sheet structure
      const sheet = ss.getActiveSheet();
      sheet.setName('Updates');
      sheet.appendRow([
        'ID', 'Date Added', 'Site Name', 'Source', 'Title (ZH)', 'Title (EN)', 'Category', 'Tier', 'URL', 'Email Status'
      ]);
      
      // Format header row (bold, dark theme background, white text)
      sheet.setFrozenRows(1);
      const headerRange = sheet.getRange(1, 1, 1, 10);
      headerRange.setFontWeight('bold');
      headerRange.setBackground('#0f172a');
      headerRange.setFontColor('#ffffff');
      headerRange.setHorizontalAlignment('center');
      
      // Auto-fit column widths
      sheet.autoResizeColumns(1, 10);
    }
  }
  
  return ss;
}

/**
 * Fetch and parse a JSON endpoint from the GitHub Pages site
 */
function fetchJson(endpoint) {
  const config = getConfigs();
  if (!config.githubPagesUrl) {
    throw new Error('GITHUB_PAGES_URL Script Property is not set.');
  }
  
  const url = `${config.githubPagesUrl}/data/${endpoint}`;
  console.log(`Fetching data from: ${url}`);
  
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: false,
    headers: { 'Accept': 'application/json' }
  });
  
  return JSON.parse(response.getContentText());
}

/**
 * Pulls the latest news items from GitHub Pages and writes new items to the Google Sheet.
 * Performs deduplication natively by comparing item IDs.
 */
function syncNewsToSheet() {
  const ss = getOrCreateSpreadsheet();
  const sheet = ss.getSheetByName('Updates');
  
  let data;
  try {
    data = fetchJson('latest-24h.json');
  } catch (err) {
    console.error('Failed to fetch latest news JSON: ' + err.toString());
    return 0;
  }
  
  const items = data.items || [];
  if (items.length === 0) {
    console.log('No news items found in feed.');
    return 0;
  }
  
  // Read existing IDs from Sheet (Column A) to prevent duplicates
  const lastRow = sheet.getLastRow();
  const existingIds = new Set();
  if (lastRow > 1) {
    const idValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    idValues.forEach(row => {
      if (row[0]) existingIds.add(row[0].toString());
    });
  }
  
  let addedCount = 0;
  items.forEach(item => {
    if (item.id && !existingIds.has(item.id)) {
      existingIds.add(item.id);
      
      const timestamp = item.published_at || item.first_seen_at || new Date().toISOString();
      const titleZh = item.title_zh || '';
      const titleEn = item.title_en || item.title || '';
      const category = item.ai_label || item.label || 'general';
      const tier = item.source_tier || 'other';
      
      sheet.appendRow([
        item.id,
        timestamp,
        item.site_name || '',
        item.source || '',
        titleZh,
        titleEn,
        category,
        tier,
        item.url || '',
        'PENDING' // Set status to PENDING for the email alert poller
      ]);
      addedCount++;
    }
  });
  
  if (addedCount > 0) {
    console.log(`Synced news: Added ${addedCount} new items to the spreadsheet.`);
  } else {
    console.log('Synced news: No new updates to add.');
  }
  
  return addedCount;
}

/**
 * Triggered manually or by a Daily Time-Driven Trigger.
 * Sends a summary of the latest 24 hours of AI news.
 * Robust design: Falls back to Sheet data if the daily-brief.json endpoint is unavailable.
 */
function sendDailyDigest() {
  const config = getConfigs();
  if (!config.recipientEmails) {
    console.error('RECIPIENT_EMAILS property is empty. Cannot send daily digest.');
    return;
  }

  try {
    let data;
    let isBrief = true;
    let items = [];
    
    try {
      data = fetchJson('daily-brief.json');
      items = data.stories || [];
    } catch (e) {
      console.warn('Could not fetch daily-brief.json, falling back to reading recent sheet database records.', e.toString());
      items = getRecentItemsFromSheet(24);
      isBrief = false;
    }

    if (items.length === 0) {
      console.log('No news items found for the daily digest. Skipping email.');
      return;
    }

    const subject = `${config.subjectPrefix} Daily Digest - ${items.length} AI Updates (${new Date().toLocaleDateString()})`;
    const htmlBody = buildDigestHtml(items, isBrief);
    
    GmailApp.sendEmail(config.recipientEmails, subject, '', {
      htmlBody: htmlBody,
      name: 'AI News Radar'
    });
    
    console.log(`Daily digest sent to ${config.recipientEmails} with ${items.length} updates.`);
  } catch (err) {
    console.error('Error sending daily digest:', err.toString());
  }
}

/**
 * Triggered by a short interval Time-Driven Trigger (e.g., every 15 or 30 minutes).
 * Syncs the news database, checks the sheet for rows with "PENDING" Email Status,
 * sends them, and updates their status to "SENT".
 */
function sendRealtimeAlerts() {
  const config = getConfigs();
  if (!config.recipientEmails) {
    console.error('RECIPIENT_EMAILS property is empty. Cannot send real-time alerts.');
    return;
  }

  try {
    // 1. Sync from GitHub Pages to ensure Sheets database is up to date
    syncNewsToSheet();
    
    // 2. Open Sheet and search for PENDING entries
    const ss = getOrCreateSpreadsheet();
    const sheet = ss.getSheetByName('Updates');
    const lastRow = sheet.getLastRow();
    
    if (lastRow <= 1) {
      console.log('Database sheet is empty. No alerts to process.');
      return;
    }
    
    const range = sheet.getRange(2, 1, lastRow - 1, 10);
    const values = range.getValues();
    const pendingItems = [];
    const pendingRowIndices = []; // Keep track of spreadsheet row numbers (1-indexed, starting at 2)
    
    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      const status = row[9]; // Column J: Email Status
      
      if (status === 'PENDING') {
        pendingItems.push({
          id: row[0],
          timestamp: row[1],
          site_name: row[2],
          source: row[3],
          title_zh: row[4],
          title_en: row[5],
          ai_label: row[6],
          source_tier: row[7],
          url: row[8]
        });
        pendingRowIndices.push(i + 2); // row index in sheet is offset by +2
      }
    }
    
    if (pendingItems.length === 0) {
      console.log('No pending updates detected.');
      return;
    }
    
    // 3. Format and send the email with new items
    const subject = `${config.subjectPrefix} Real-time Alert: ${pendingItems.length} New AI Updates!`;
    const htmlBody = buildRealtimeHtml(pendingItems);

    GmailApp.sendEmail(config.recipientEmails, subject, '', {
      htmlBody: htmlBody,
      name: 'AI News Radar Alert'
    });

    // 4. Update status to SENT in the Sheet
    pendingRowIndices.forEach(rowIndex => {
      sheet.getRange(rowIndex, 10).setValue('SENT');
    });
    
    console.log(`Real-time alert sent with ${pendingItems.length} new items. Updated spreadsheet records.`);
  } catch (err) {
    console.error('Error executing real-time alerts:', err.toString());
  }
}

/**
 * Reads recently added items from the Sheet database for daily digest fallback
 */
function getRecentItemsFromSheet(hoursLimit) {
  const ss = getOrCreateSpreadsheet();
  const sheet = ss.getSheetByName('Updates');
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  
  const values = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
  const cutoff = new Date(Date.now() - hoursLimit * 60 * 60 * 1000);
  const recentItems = [];
  
  values.forEach(row => {
    const timestampStr = row[1];
    const itemDate = new Date(timestampStr);
    
    if (!isNaN(itemDate.getTime()) && itemDate >= cutoff) {
      recentItems.push({
        id: row[0],
        timestamp: row[1],
        site_name: row[2],
        source: row[3],
        title_zh: row[4],
        title_en: row[5],
        ai_label: row[6],
        source_tier: row[7],
        url: row[8]
      });
    }
  });
  
  // Sort reverse chronological
  recentItems.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return recentItems;
}

/**
 * Webhook handler to receive POST requests for instant notification.
 * This can be triggered from your GitHub Actions workspace.
 */
function doPost(e) {
  const config = getConfigs();
  
  try {
    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return ContentService.createTextOutput(JSON.stringify({ 
        success: false, 
        error: 'Invalid JSON request payload' 
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // Authenticate if WEBHOOK_TOKEN is configured
    if (config.webhookToken) {
      const requestToken = e.parameter.token || payload.token || '';
      if (requestToken !== config.webhookToken) {
        return ContentService.createTextOutput(JSON.stringify({ 
          success: false, 
          error: 'Unauthorized. Invalid or missing token parameter.' 
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    const action = payload.action || '';
    if (action === 'poll' || action === 'realtime') {
      sendRealtimeAlerts();
      return ContentService.createTextOutput(JSON.stringify({ 
        success: true, 
        message: 'Sync and real-time news alerts executed successfully.' 
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // If payload contains items, insert them into the sheet directly as PENDING
    const items = payload.items || [];
    if (items.length > 0) {
      const ss = getOrCreateSpreadsheet();
      const sheet = ss.getSheetByName('Updates');
      
      const lastRow = sheet.getLastRow();
      const existingIds = new Set();
      if (lastRow > 1) {
        const idValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
        idValues.forEach(row => {
          if (row[0]) existingIds.add(row[0].toString());
        });
      }
      
      let added = 0;
      items.forEach(item => {
        if (item.id && !existingIds.has(item.id)) {
          existingIds.add(item.id);
          
          const timestamp = item.published_at || item.first_seen_at || new Date().toISOString();
          const titleZh = item.title_zh || '';
          const titleEn = item.title_en || item.title || '';
          const category = item.ai_label || item.label || 'general';
          const tier = item.source_tier || 'other';
          
          sheet.appendRow([
            item.id,
            timestamp,
            item.site_name || '',
            item.source || '',
            titleZh,
            titleEn,
            category,
            tier,
            item.url || '',
            'PENDING'
          ]);
          added++;
        }
      });
      
      if (added > 0) {
        // Trigger alerts for newly inserted items immediately
        sendRealtimeAlerts();
      }
      
      return ContentService.createTextOutput(JSON.stringify({ 
        success: true, 
        message: `Successfully loaded ${added} custom updates and triggered email processor.` 
      })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ 
      success: true, 
      message: 'No action performed.' 
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ 
      success: false, 
      error: err.toString() 
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * HTML Email Generator for Daily Digest
 */
function buildDigestHtml(items, isBrief) {
  const config = getConfigs();
  let cardsHtml = '';

  items.forEach(item => {
    // Determine details depending on story-brief format vs sheet-record format
    const title = item.title_bilingual || item.title || 'Untitled Update';
    const url = item.url || '#';
    const siteName = item.site_name || item.source || 'AI Source';
    const tier = item.source_tier || 'other';
    const label = item.ai_label || item.label || 'general';
    
    // Grouping of related items if it's a story brief
    let referencesHtml = '';
    if (isBrief && item.items && item.items.length > 1) {
      referencesHtml = '<div style="margin-top: 10px; padding-top: 8px; border-top: 1px dashed #e2e8f0; font-size: 12px; color: #64748b;">';
      referencesHtml += '<strong>Related Sources:</strong> ';
      const refs = item.items.map(ref => {
        const refUrl = ref.url || '#';
        const refSrc = ref.source || ref.site_name || 'Link';
        return `<a href="${refUrl}" target="_blank" style="color: #4f46e5; text-decoration: none; margin-right: 8px;">${refSrc}</a>`;
      });
      referencesHtml += refs.join(', ');
      referencesHtml += '</div>';
    }

    // Badges layout
    const labelBadge = `<span style="display: inline-block; padding: 2px 8px; font-size: 11px; font-weight: 600; border-radius: 4px; background-color: #f5f3ff; color: #7c3aed; margin-right: 6px; text-transform: uppercase;">${label.replace('_', ' ')}</span>`;
    const tierBadge = `<span style="display: inline-block; padding: 2px 8px; font-size: 11px; font-weight: 600; border-radius: 4px; background-color: #f0fdf4; color: #15803d; text-transform: uppercase;">Tier ${tier}</span>`;

    // Render bilingual titles clean
    let titleHtml = '';
    if (item.title_zh && item.title_en) {
      titleHtml = `
        <div style="font-size: 16px; font-weight: 600; color: #0f172a; margin-bottom: 2px; line-height: 1.4;">${item.title_zh}</div>
        <div style="font-size: 13px; color: #64748b; font-style: italic; margin-bottom: 8px; line-height: 1.4;">${item.title_en}</div>
      `;
    } else {
      titleHtml = `
        <div style="font-size: 16px; font-weight: 600; color: #0f172a; margin-bottom: 8px; line-height: 1.4;">${title}</div>
      `;
    }

    cardsHtml += `
      <div style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <div style="margin-bottom: 10px;">
          ${labelBadge} ${tierBadge}
        </div>
        ${titleHtml}
        <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 12px;">
          <span style="font-size: 12px; color: #94a3b8;">Via ${siteName}</span>
          <a href="${url}" target="_blank" style="display: inline-block; padding: 6px 14px; background-color: #4f46e5; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 12px; font-weight: 500;">Read More</a>
        </div>
        ${referencesHtml}
      </div>
    `;
  });

  return getTemplateHtml('Daily AI News Digest', `Here are the latest AI developments compiled in the last 24 hours.`, cardsHtml);
}

/**
 * HTML Email Generator for Real-time alerts
 */
function buildRealtimeHtml(items) {
  let cardsHtml = '';

  items.forEach(item => {
    const title = item.title_bilingual || item.title || 'Untitled Update';
    const url = item.url || '#';
    const siteName = item.site_name || item.source || 'AI Source';
    const label = item.ai_label || item.label || 'general';

    const badge = `<span style="display: inline-block; padding: 2px 8px; font-size: 11px; font-weight: 600; border-radius: 4px; background-color: #fef3c7; color: #d97706; text-transform: uppercase;">NEW UPDATE</span>`;

    let titleHtml = '';
    if (item.title_zh && item.title_en) {
      titleHtml = `
        <div style="font-size: 16px; font-weight: 600; color: #0f172a; margin-bottom: 2px; line-height: 1.4;">${item.title_zh}</div>
        <div style="font-size: 13px; color: #64748b; font-style: italic; margin-bottom: 8px; line-height: 1.4;">${item.title_en}</div>
      `;
    } else {
      titleHtml = `
        <div style="font-size: 16px; font-weight: 600; color: #0f172a; margin-bottom: 8px; line-height: 1.4;">${title}</div>
      `;
    }

    cardsHtml += `
      <div style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <div style="margin-bottom: 10px;">
          ${badge} <span style="font-size: 11px; color: #64748b; font-weight: 500;">Tag: ${label.replace('_', ' ')}</span>
        </div>
        ${titleHtml}
        <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 12px;">
          <span style="font-size: 12px; color: #94a3b8;">Source: ${siteName}</span>
          <a href="${url}" target="_blank" style="display: inline-block; padding: 6px 14px; background-color: #d97706; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 12px; font-weight: 500;">Read Article</a>
        </div>
      </div>
    `;
  });

  return getTemplateHtml('Instant AI News Alert', `We detected ${items.length} new high-relevance update(s).`, cardsHtml);
}

/**
 * Base styling wrapper layout for modern aesthetics
 */
function getTemplateHtml(title, subtitle, contentHtml) {
  const config = getConfigs();
  const siteLink = config.githubPagesUrl || '#';
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
      <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; padding: 24px 12px;">
        <tr>
          <td align="center">
            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03);">
              <!-- Gradient Header -->
              <tr>
                <td style="background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); padding: 32px 24px; text-align: center;">
                  <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">${title}</h1>
                  <p style="margin: 8px 0 0 0; color: #e0e7ff; font-size: 14px; font-weight: 400;">${subtitle}</p>
                </td>
              </tr>
              <!-- Card Content Area -->
              <tr>
                <td style="padding: 24px; background-color: #f8fafc;">
                  ${contentHtml}
                </td>
              </tr>
              <!-- Call to Action Footer link -->
              <tr>
                <td style="padding: 0 24px 24px 24px; background-color: #f8fafc; text-align: center;">
                  <a href="${siteLink}" target="_blank" style="display: inline-block; padding: 12px 24px; background-color: #ffffff; border: 1px solid #e2e8f0; color: #4f46e5; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">Open AI News Radar Web App</a>
                </td>
              </tr>
              <!-- Email Footer info -->
              <tr>
                <td style="padding: 24px; background-color: #0f172a; text-align: center; color: #94a3b8; font-size: 12px;">
                  <p style="margin: 0 0 8px 0;">This email is automated from your AI News Radar deployment.</p>
                  <p style="margin: 0;">© ${new Date().getFullYear()} AI News Radar. Open-source under MIT.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}
