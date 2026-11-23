# Bastaa Orders ⇄ Google Sheets ⇄ WhatsApp (free)

This connects the Bastaa Orders app to a Google Sheet, and the sheet to WhatsApp. It uses no paid services.

| Part | What you get | Cost |
|---|---|---|
| **1. Orders → Google Sheet** | Every order copied to an **Orders** tab, with a live *Days Left* column | Free (Google Apps Script) |
| **2. WhatsApp links in the sheet** | A **💬 Send update** link on every order. It opens WhatsApp with the right message for that order's status, ready to send | Free, no API needed |
| **3. WhatsApp inbox in the sheet** *(optional)* | Customer messages appear in a **WhatsApp Inbox** tab, matched to their orders by phone number | Free (WhatsApp Cloud API: receiving messages is free) |
| **4. Reply from the sheet** *(optional)* | Select a row → **Bastaa → Reply on WhatsApp** | Free within 24 hours of the customer's last message. After 24 hours, use the 💬 link instead |

Parts 1 and 2 take about 5 minutes. Most people only need those.

---

## Part 1 & 2: Send orders to a Google Sheet (5 minutes)

1. Open [sheets.new](https://sheets.new) to create a blank Google Sheet. Name it, e.g. *Bastaa Orders*.
2. Click **Extensions → Apps Script**. Delete the code you see there, then paste everything from [`Code.gs`](Code.gs). Click 💾 **Save**.
3. In the function dropdown at the top, select **`setup`** and click **▶ Run**.
   - Google asks for permission the first time. Click **Review permissions**, choose your account, then **Advanced → Go to (project name) → Allow**. This warning appears because you wrote the script yourself; it only gets access to this sheet.
   - When it finishes, the **Execution log** shows your **secret key**. Copy it.
4. Click **Deploy → New deployment**. Click ⚙️ next to *Select type* and choose **Web app**:
   - *Execute as*: **Me**
   - *Who has access*: **Anyone** (the secret key stops other people from writing to your sheet)
   - Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
5. In the Bastaa Orders app, open ⚙️ **Settings → Google Sheet & WhatsApp**:
   - Paste the **Web app URL** and the **Secret key**.
   - Keep **Sync automatically** ticked.
   - Tap **🔄 Sync to Google Sheet now**. Your orders appear in the **Orders** tab.

From now on, the sheet updates a couple of seconds after you add, edit, delete or change the status of an order. If you are offline, the app syncs when you're back online, or the next time you open it.

**Good to know**
- The app is the master copy. The **Orders** tab is rewritten on every sync, so don't type into it. Add your own tabs for anything else; they are never touched.
- Photos are not uploaded. The sheet shows how many photos each product has.
- Sync from **one** device. If you use the app on two devices, each one overwrites the sheet with its own orders. Use Settings → backup/restore to move orders between devices.
- To find the secret key again, open the sheet and use the **Bastaa → Show secret key & verify token** menu.
- If you change `Code.gs` later, go to **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same.

---

## Part 3: Receive WhatsApp messages in the sheet (optional, ~20 minutes)

This uses Meta's official **WhatsApp Cloud API**. Receiving messages is free.

1. Go to [developers.facebook.com](https://developers.facebook.com/) → **My Apps → Create app**. Choose the WhatsApp / *Business* use case and connect (or create) a Meta Business account.
2. In the app, open **WhatsApp → API Setup**. Meta gives you a free **test number**. To use your real business number, click **Add phone number**.
   - A number already used in the normal WhatsApp or WhatsApp Business app must be moved to the API, unless Meta offers "coexistence" for your number. Many people use a second SIM for this.
3. Open **WhatsApp → Configuration → Webhook → Edit**:
   - **Callback URL**: your Web app URL from Part 1.
   - **Verify token**: the verify token shown by `setup` (or the **Bastaa → Show secret key & verify token** menu).
   - Click **Verify and save**. Then, under **Webhook fields**, **Subscribe** to **messages**.
4. Send a WhatsApp message to the business number. It appears in the **WhatsApp Inbox** tab within a few seconds. If the customer has an order, its order number appears in *Matching Orders*.

## Part 4: Reply from the sheet (optional)

1. Get a **permanent token**: [business.facebook.com](https://business.facebook.com/) → **Settings → Users → System users → Add**. Assign your WhatsApp app and WhatsApp account to that user, then **Generate token** with the `whatsapp_business_messaging` and `whatsapp_business_management` permissions. (The token on the API Setup page expires after 24 hours.)
2. Reload the sheet. Click **Bastaa → Set WhatsApp API credentials**, and enter the **Phone number ID** (from WhatsApp → API Setup) and the token.
3. Select a row in **Orders** or **WhatsApp Inbox**, then click **Bastaa → Reply on WhatsApp to selected row**. Sent replies are logged in the inbox as *Outgoing*.

**WhatsApp rules (from Meta, not this script):** you can send free-form messages only within **24 hours** of the customer's last message, and those replies are free. Starting a conversation after that needs an approved *template* message, which Meta charges per message. The free way to message anyone at any time is the **💬 Send update** link, which opens your own WhatsApp app.

---

## Limits & security
- Google's free quotas are far above what a small shop uses (e.g. 20,000 outgoing requests a day).
- Apps Script cannot read request headers, so it cannot check Meta's webhook signature. Keep the Web app URL private. At worst, someone who has the URL could add fake rows to the inbox; they cannot read your sheet or change orders without the secret key.
- Apps Script answers webhooks with a redirect, so Meta sometimes sends the same message twice. The script skips messages it has already logged.
