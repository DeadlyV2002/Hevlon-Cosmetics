// Sends the monthly stock-update reminders and follow-ups (email through Resend, WhatsApp through
// the WhatsApp Business Cloud API). Runs once a day from pg_cron; the Settings page can also run it.
// Secrets (Supabase → Edge Functions → Secrets): RESEND_API_KEY, REMINDER_FROM, WHATSAPP_TOKEN,
// WHATSAPP_PHONE_ID, CRON_SECRET. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) || "";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret" };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "98765 43210, 91-9876543211" → ["919876543210", "919876543211"] */
const waNumbers = (phone: string | null) => (phone || "").split(/[,/;\n]+/).map(p => p.replace(/\D/g, "").slice(-10)).filter(p => p.length === 10).map(p => `91${p}`);

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  // Either the daily schedule (shared secret) or a signed-in HO admin / state manager.
  let manual = false;
  if (!env("CRON_SECRET") || req.headers.get("x-cron-secret") !== env("CRON_SECRET")) {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
    const { data: u } = await db.auth.getUser(token);
    if (!u?.user) return reply(401, { error: "Sign in first." });
    const { data: p } = await db.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
    if (!p || !["HO_ADMIN", "STATE_MANAGER"].includes(p.role)) return reply(403, { error: "Only HO admins and state managers can send reminders." });
    manual = true;
  }

  const { data: cfgRow } = await db.from("app_settings").select("value").eq("key", "reminders").maybeSingle();
  const cfg = (cfgRow?.value || {}) as Record<string, any>;
  if (!cfg.enabled) return reply(200, { sent: 0, failed: 0, note: "Reminders are switched off in Settings." });
  const { data: due, error } = await db.rpc("reminders_due");
  if (error) return reply(500, { error: error.message });

  let sent = 0, failed = 0;
  for (const r of (due || []) as { location_id: string; name: string; email: string | null; phone: string | null; period: string; kind: "FIRST" | "FOLLOW_UP" }[]) {
    const month = `${MONTHS[Number(r.period.slice(5, 7)) - 1]} ${r.period.slice(0, 4)}`;
    const follow = r.kind === "FOLLOW_UP";
    const subject = follow ? `Reminder: stock statement for ${month} still pending` : `Please send your stock statement for ${month}`;
    const text = `Dear ${r.name},\n\n${follow ? `We haven't received your closing stock statement for ${month} yet.` : `Please send your closing stock statement for ${month}.`} Reply to this message with the Tally stock summary or an Excel sheet.\n\nThank you,\nKolor Activ (Hevlon Cosmetics)`;
    const log = (channel: "EMAIL" | "WHATSAPP", to: string, ok: boolean, err = "") =>
      db.from("reminder_log").insert({ location_id: r.location_id, period: r.period, kind: r.kind, channel, sent_to: to, ok, error: err || null });

    if (cfg.email !== false && r.email) {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST", headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: env("REMINDER_FROM"), to: r.email.split(/[,;]\s*/).filter(Boolean), subject, text }),
        });
        const ok = res.ok; ok ? sent++ : failed++;
        await log("EMAIL", r.email, ok, ok ? "" : `Email: ${(await res.text()).slice(0, 300)}`);
      } catch (e) { failed++; await log("EMAIL", r.email, false, `Email: ${String(e)}`); }
    }
    if (cfg.whatsapp !== false) {
      for (const to of waNumbers(r.phone)) {
        try {
          const res = await fetch(`https://graph.facebook.com/v20.0/${env("WHATSAPP_PHONE_ID")}/messages`, {
            method: "POST", headers: { Authorization: `Bearer ${env("WHATSAPP_TOKEN")}`, "Content-Type": "application/json" },
            // Business-started WhatsApp messages must use a template approved in WhatsApp Manager,
            // with {{1}} = distributor name and {{2}} = month.
            body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: {
              name: cfg.wa_template || "stock_update_reminder", language: { code: cfg.wa_language || "en" },
              components: [{ type: "body", parameters: [{ type: "text", text: r.name }, { type: "text", text: month }] }] } }),
          });
          const ok = res.ok; ok ? sent++ : failed++;
          await log("WHATSAPP", to, ok, ok ? "" : `WhatsApp: ${(await res.text()).slice(0, 300)}`);
        } catch (e) { failed++; await log("WHATSAPP", to, false, `WhatsApp: ${String(e)}`); }
      }
    }
  }
  return reply(200, { sent, failed, locations: (due || []).length, manual });
});
