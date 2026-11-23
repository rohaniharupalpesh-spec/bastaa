# Bastaa Orders

A simple app for tracking **custom (made-to-order) Bastaa orders**. It reminds you a few days before each order is due.

Open `index.html` in a browser, or host the folder (e.g. GitHub Pages) and use **Add to Home Screen** to install it on your phone. It works offline.

## Features
- **Orders with full customization**: customer and phone, order and due dates, priority, and any number of products per order. Each product has colour, size, material, personalization (name, monogram, embroidery), free-text details and **reference photos**.
- **Reminders**:
  - A banner and 🔔 badge list every order inside its reminder window, plus overdue ones.
  - The default reminder window is 3 days. Change it in ⚙️ Settings, or set a different one on a single order.
  - Phone/desktop notifications (enable in Settings), once per order per day.
  - **Add to calendar** (.ics) for one order, or all open orders. Your phone's calendar then alerts you N days before at 9am and again on the due day, even when the app is closed.
- **Status tracking**: Received → In Production → Ready → Delivered (or Cancelled), with a history log.
- **Payments**: the total is calculated from the products. The app shows advance and balance, and the total still to collect on open orders.
- **WhatsApp update**: one tap opens a ready-made message to the customer, based on the order status.
- **Job sheet**: a printable page with all customization details and photos, for the workshop.
- Search, filter and sort. Export to Excel (CSV).
- **Google Sheet sync (free)**: orders copy to a Google Sheet automatically, with a WhatsApp link for each order. You can also log customers' WhatsApp messages in the sheet and reply from it. Setup: [`google-sheets/README.md`](google-sheets/README.md).

## Your data
Orders are stored **only on the device/browser you use** (IndexedDB). Use **Settings → Download backup** regularly. To move orders to another device, use **Restore backup** there.

## Online version
`artifact/bastaa-orders.html` is a single-page version published as a private Claude artifact. It saves orders online, so the same orders show on your phone and computer. It adds reminders through Google Calendar links, and it uses copy-to-clipboard job sheets instead of printing.
