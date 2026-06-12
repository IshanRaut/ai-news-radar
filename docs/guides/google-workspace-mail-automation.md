# Google Workspace Email Automation & Google Sheets Database Guide

This guide explains how to connect your **AI News Radar** static site updates to a **Google Sheets Database** in Google Drive and automate email alerts through Gmail using Google Apps Script. 

By setting up this flow:
1. **Spreadsheet Database**: All news updates will be synced and archived in a Google Spreadsheet named `AI News Radar Database` in your Google Drive.
2. **Real-time Alerts**: The script polls your JSON feed, logs new updates as `PENDING` in the sheet, sends an instant Gmail alert, and marks them as `SENT`.
3. **Daily Digest**: A daily newsletter summary of AI news updates from the past 24 hours.

---

## 📊 How the Google Sheet Database Works

When the script runs for the first time, it automatically creates a Google Spreadsheet named `AI News Radar Database` in your Google Drive with the following columns:

| Column | Name | Description |
| :--- | :--- | :--- |
| **A** | `ID` | The unique hash ID of the news item (used for native deduplication). |
| **B** | `Date Added` | The publication or discovery timestamp of the news item. |
| **C** | `Site Name` | The main site domain or publisher name. |
| **D** | `Source` | The specific channel or feed author (e.g. `@username`). |
| **E** | `Title (ZH)` | The translated Chinese title (if translated). |
| **F** | `Title (EN)` | The original English title. |
| **G** | `Category` | The AI tag (e.g. `model_release`, `research_paper`, `developer_tool`). |
| **H** | `Tier` | The priority source tier rank (`Tier 1`, `Tier 2`, etc.). |
| **I** | `URL` | The link to the original article source. |
| **J** | `Email Status` | Tracks email delivery. Appends as `PENDING`, and updates to `SENT` after emailing. |

> [!TIP]
> **Manual Control**: Since this is a standard Google Sheet, you can open it anytime to manually add, edit, or delete items. If you manually type a new row and set the `Email Status` to `PENDING`, the script will automatically email it to you on the next execution!

---

## 🛠️ Step 1: Create a Google Apps Script Project

1. Navigate to [Google Apps Script (script.google.com)](https://script.google.com) and log in with your Gmail or Google Workspace account.
2. Click **New Project** in the top left.
3. Rename the project from "Untitled project" to **AI News Radar Database Mailer**.
4. In the editor, delete any template code in `Code.gs` and paste the contents of:
   👉 [scripts/google_apps_script.js](file:///c:/News%20updates/scripts/google_apps_script.js)
5. Save the project by clicking the **Save** (disk) icon or pressing `Ctrl + S`.

---

## ⚙️ Step 2: Configure Script Properties

1. In the Apps Script sidebar, click the **Project Settings** (gear icon ⚙️).
2. Scroll down to **Script Properties** and click **Add script property**.
3. Add the following key-value pairs:

| Property Name | Example Value | Description |
| :--- | :--- | :--- |
| `GITHUB_PAGES_URL` | `https://learnprompt.github.io/ai-news-radar` | The URL of your deployed GitHub Pages site. |
| `RECIPIENT_EMAILS` | `your-email@gmail.com, team@example.com` | Comma-separated list of emails to receive alerts. |
| `EMAIL_SUBJECT_PREFIX` | `[AI News Radar]` | Prefix for the email subject line. |
| `WEBHOOK_TOKEN` | `my-secret-token-here` | (Optional) Custom password string for webhook security. |

4. Click **Save script properties**.

---

## 🕒 Step 3: Set Up Time-Driven Triggers

To make the database synchronization and email notifications run automatically:

1. In the Apps Script sidebar, click the **Triggers** (alarm clock icon ⏰).
2. Click the **Add Trigger** button in the bottom right.

### Trigger A: Real-time Alerts & Database Sync (Every 15-30 mins)
* **Choose which function to run**: `sendRealtimeAlerts`
* **Choose which deployment should run**: `Head`
* **Select event source**: `Time-driven`
* **Select type of time based trigger**: `Minutes timer`
* **Select minute interval**: Choose `Every 15 minutes` or `Every 30 minutes`.
* Click **Save**.

### Trigger B: Daily Digest Newsletter
* **Choose which function to run**: `sendDailyDigest`
* **Choose which deployment should run**: `Head`
* **Select event source**: `Time-driven`
* **Select type of time based trigger**: `Day timer`
* **Select time of day**: Select your preferred time window (e.g., `8 AM to 9 AM`).
* Click **Save**.

> [!NOTE]
> **Granting Permissions**:
> When you save your first trigger, Google will display a popup requesting authorization.
> - Select your Google account.
> - Click **Advanced** and then click **Go to AI News Radar Database Mailer (unsafe)**.
> - The prompt will ask for permissions to read/write files in Google Drive (to manage the spreadsheet database), send emails (via Gmail), and connect to external services (to fetch your JSON feed). Click **Allow**.

---

## ⚡ Step 4: Setup Webhook Trigger for Instant Syncs (Optional)

Instead of waiting for the 15/30-minute poll trigger, you can configure GitHub Actions to trigger the database synchronization and email dispatch *instantly* whenever news updates are pushed to master.

### 1. Deploy the Apps Script as a Web App
1. Inside your Apps Script project, click the **Deploy** button in the top right, then select **New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Fill in the deployment details:
   - **Description**: `AI News Radar Webhook`
   - **Execute as**: `Me (your-email@gmail.com)`
   - **Who has access**: `Anyone`
4. Click **Deploy**.
5. Copy the **Web app URL** generated (it will look like `https://script.google.com/macros/s/.../exec`).

### 2. Configure GitHub Secrets
1. Go to your **GitHub Repository** -> **Settings** -> **Secrets and variables** -> **Actions**.
2. Click **New repository secret** and add:
   - Name: `GOOGLE_WORKSPACE_WEBAPP_URL`
   - Value: (The Web App URL you just copied)
3. Click **New repository secret** again:
   - Name: `GOOGLE_WORKSPACE_WEBHOOK_TOKEN`
   - Value: (The custom string you added to `WEBHOOK_TOKEN` in Step 2)

### 3. Add Webhook to GitHub Actions Workflow
In your `.github/workflows/update-news.yml` file, append the following step at the very end of the `update` job (after the commit and push step):

```yaml
      - name: Trigger Google Workspace Sync Webhook
        env:
          WEBAPP_URL: ${{ secrets.GOOGLE_WORKSPACE_WEBAPP_URL }}
          WEBHOOK_TOKEN: ${{ secrets.GOOGLE_WORKSPACE_WEBHOOK_TOKEN }}
        run: |
          if [ -n "$WEBAPP_URL" ] && [ -n "$WEBHOOK_TOKEN" ]; then
            echo "Pinging Workspace Web App to sync spreadsheet and process emails..."
            curl -s -X POST -H "Content-Type: application/json" \
              -d "{\"action\": \"poll\", \"token\": \"$WEBHOOK_TOKEN\"}" \
              "$WEBAPP_URL"
          else
            echo "Webhook configuration missing. Skipping instant email."
          fi
```

---

## 🧪 Testing the Integration

To verify everything:
1. Open your Apps Script editor.
2. Select **`sendRealtimeAlerts`** from the run toolbar dropdown and click **Run**.
3. Open your Google Drive—you should see a new sheet named **`AI News Radar Database`** populated with recent news updates.
4. Check your Gmail inbox—you should receive an alert email containing those news items, and the `Email Status` in the Sheet should change to `SENT`.
5. Select **`sendDailyDigest`** and click **Run** to check the layout of the daily newsletter.
