import nodemailer from "npm:nodemailer@6.9.16";
import { createClient } from "npm:@supabase/supabase-js@2.49.1";
// supabase/functions/_shared/domain/emailTemplates.ts
function escapeHtml(v) {
	return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function formatDate(iso, tz) {
	if (!iso) return "To Be Announced";
	const d = new Date(String(iso));
	if (Number.isNaN(d.getTime())) return "To Be Announced";
	try {
		return new Intl.DateTimeFormat("en-GB", {
			dateStyle: "full",
			timeStyle: "short",
			timeZone: tz || "UTC"
		}).format(d) + (tz ? ` (${tz})` : " (UTC)");
	} catch {
		return d.toUTCString();
	}
}
const s = escapeHtml;
const tba = (v) => v ? s(v) : "To Be Announced";
function boutLines(p) {
	return [
		`<strong>Event:</strong> ${s(p.event_name)}`,
		p.opponent_name ? `<strong>Opponent:</strong> ${s(p.opponent_name)}` : "",
		p.weight_class ? `<strong>Weight class:</strong> ${s(p.weight_class)}` : "",
		p.rounds ? `<strong>Format:</strong> ${s(p.rounds)} × ${s(p.round_minutes)} min` : "",
		"starts_at" in p ? `<strong>Date:</strong> ${s(formatDate(p.starts_at, p.timezone))}` : "",
		"venue_name" in p ? `<strong>Venue:</strong> ${tba(p.venue_name)}` : ""
	].filter(Boolean);
}
function build(template, p, ctx) {
	const site = ctx.siteUrl.replace(/\/$/, "");
	const adminBout = p.bout_id ? `${site}/admin/bouts?bout=${encodeURIComponent(String(p.bout_id))}` : `${site}/admin/bouts`;
	const eventLink = p.event_slug ? `${site}/events/${encodeURIComponent(String(p.event_slug))}` : void 0;
	const portal = `${site}/fighter`;
	const loginHelp = (code) => `<strong>How to log in:</strong> Login ID = your fighter ID${code ? ` (<strong>${s(code)}</strong>)` : ""} · Password = your date of birth as DDMMYYYY (e.g. 10 March 1987 = 10031987).`;
	const base = template.replace(/_coach$/, "");
	const coach = template.endsWith("_coach");
	const who = coach ? `your fighter ${s(p.fighter_name)}` : "you";
	switch (template) {
		case "fighter_registration_confirmation":
		case "fighter_id_delivery": return {
			subject: `Your fighter ID: ${p.fighter_code}`,
			heading: p.reused ? "Registration received" : "Welcome — your fighter ID",
			lines: [
				`Hi ${s(p.fighter_name)},`,
				p.event_name ? `We received your registration for <strong>${s(p.event_name)}</strong>. It will be reviewed by the organisers.` : "Your fighter profile has been created.",
				`Your permanent fighter ID is <span style="font-size:22px;font-weight:700;letter-spacing:1px">${s(p.fighter_code)}</span>`,
				"Keep this ID. You need it to log in to the fighter area, where bout offers appear, and to register for future events.",
				loginHelp(p.fighter_code)
			],
			action: {
				label: "Fighter login",
				url: portal
			}
		};
		case "coach_fighter_submitted": return {
			subject: `Fighter registered: ${p.fighter_name}`,
			heading: "Fighter registered",
			lines: [`${s(p.fighter_name)} (${s(p.fighter_code)}) was registered${p.event_name ? ` for ${s(p.event_name)}` : ""}.`]
		};
		case "coach_registration_confirmation": return {
			subject: "Coach registration received",
			heading: "Registration received",
			lines: [`Hi ${s(p.coach_name)},`, `Thanks for registering${p.event_name ? ` for ${s(p.event_name)}` : ""}. An administrator will verify your details and email you an invitation to the coach portal.`]
		};
		case "coach_verified": return {
			subject: "Your coach registration is verified",
			heading: "You are verified",
			lines: [`Hi ${s(p.coach_name)}, your coach registration has been verified. You will receive a separate email to set up your account.`]
		};
		case "coach_rejected": return {
			subject: "Your coach registration",
			heading: "Registration not approved",
			lines: [`Hi ${s(p.coach_name)}, we could not verify your registration.`, p.reason ? `Reason: ${s(p.reason)}` : ""].filter(Boolean)
		};
		case "registration_approved": return {
			subject: `Approved: ${p.event_name}`,
			heading: "Registration approved",
			lines: [`Hi ${s(p.fighter_name)} (${s(p.fighter_code)}),`, `Your registration for <strong>${s(p.event_name)}</strong> has been approved. We will contact you if a bout is offered.`],
			action: eventLink ? {
				label: "View event",
				url: eventLink
			} : void 0
		};
		case "registration_rejected": return {
			subject: `Registration update: ${p.event_name}`,
			heading: "Registration not approved",
			lines: [
				`Hi ${s(p.fighter_name)},`,
				`Your registration for <strong>${s(p.event_name)}</strong> was not approved.`,
				p.reason ? `Reason: ${s(p.reason)}` : ""
			].filter(Boolean)
		};
		case "registration_incomplete": {
			const items = Array.isArray(p.missing_info) ? p.missing_info : [];
			return {
				subject: `Information needed: ${p.event_name}`,
				heading: "We need a little more information",
				lines: [
					`Hi ${s(p.fighter_name)} (${s(p.fighter_code)}),`,
					`To complete your registration for <strong>${s(p.event_name)}</strong>, please send:`,
					`<ul>${items.map((i) => `<li>${s(String(i).replace(/_/g, " "))}</li>`).join("")}</ul>`,
					p.reason ? s(p.reason) : "",
					"Reply to this email with the details."
				].filter(Boolean)
			};
		}
		case "bout_offer": return {
			subject: `Bout offer: ${p.event_name}`,
			heading: "You have a bout offer",
			lines: [
				`Hi ${s(p.fighter_name)},`,
				"You have been offered the following bout:",
				...boutLines(p),
				`<strong>Respond by:</strong> ${s(formatDate(p.expires_at, p.timezone))}`,
				"Log in to the fighter area to see the full details and accept or decline.",
				loginHelp(p.fighter_code)
			],
			action: {
				label: "Log in and respond",
				url: ctx.actionUrl ?? portal
			}
		};
		case "offer_expiry_reminder": return {
			subject: `Reminder: your bout offer expires soon`,
			heading: "Your offer expires soon",
			lines: [`Hi ${s(p.fighter_name)}, your offer for <strong>${s(p.event_name)}</strong> expires ${s(formatDate(p.expires_at))}.`, loginHelp(p.fighter_code)],
			action: {
				label: "Log in and respond",
				url: ctx.actionUrl ?? portal
			}
		};
		case "offer_accepted_confirmation": return {
			subject: `You accepted: ${p.event_name}`,
			heading: "Acceptance received",
			lines: [`Hi ${s(p.fighter_name)}, we recorded your acceptance of bout ${s(p.bout_code)}.`, "The bout is not final until the organisers confirm it. We will email you."]
		};
		case "offer_declined_confirmation": return {
			subject: `You declined: ${p.event_name}`,
			heading: "Decline received",
			lines: [`Hi ${s(p.fighter_name)}, we recorded that you declined bout ${s(p.bout_code)}. Thank you for letting us know.`]
		};
		case "admin_offer_accepted":
		case "admin_offer_declined":
		case "admin_both_accepted":
		case "admin_offer_expired": return {
			subject: {
				admin_offer_accepted: `Accepted: ${p.fighter_name} (${p.bout_code})`,
				admin_offer_declined: `Declined: ${p.fighter_name} (${p.bout_code}) — review needed`,
				admin_both_accepted: `Both accepted: ${p.bout_code} — awaiting your confirmation`,
				admin_offer_expired: `Offer expired: ${p.bout_code} — review needed`
			}[template],
			heading: {
				admin_offer_accepted: "Offer accepted",
				admin_offer_declined: "Offer declined",
				admin_both_accepted: "Both fighters accepted",
				admin_offer_expired: "Offer expired"
			}[template],
			lines: [
				p.fighter_name ? `${s(p.fighter_name)} — bout ${s(p.bout_code)}${p.event_name ? `, ${s(p.event_name)}` : ""}.` : `Bout ${s(p.bout_code)}.`,
				p.reason ? `Reason given: ${s(p.reason)}` : "",
				template === "admin_both_accepted" ? "The bout is not confirmed until an administrator confirms it." : ""
			].filter(Boolean),
			action: {
				label: "Open bout",
				url: adminBout
			}
		};
		case "coach_offer_response": return {
			subject: `${p.fighter_name} ${p.response === "accept" ? "accepted" : "declined"} a bout offer`,
			heading: "Offer response",
			lines: [`${s(p.fighter_name)} ${p.response === "accept" ? "accepted" : "declined"} bout ${s(p.bout_code)} at ${s(p.event_name)}.`]
		};
	}
	switch (base) {
		case "offer_expired": return {
			subject: `Bout offer expired: ${p.event_name}`,
			heading: "Offer expired",
			lines: [`The bout offer for ${who} (${s(p.bout_code)}, ${s(p.event_name)}) expired before both fighters responded. The organisers may contact ${coach ? "them" : "you"} again.`]
		};
		case "bout_confirmed": return {
			subject: `Bout confirmed: ${p.event_name}`,
			heading: "Your bout is confirmed",
			lines: [`The bout for ${who} against ${s(p.opponent_name)} at <strong>${s(p.event_name)}</strong> is confirmed (${s(p.bout_code)}).`],
			action: eventLink ? {
				label: "View event",
				url: eventLink
			} : void 0
		};
		case "bout_cancelled": return {
			subject: `Bout cancelled: ${p.event_name}`,
			heading: "Bout cancelled",
			lines: [`The bout for ${who} (${s(p.bout_code)}) at ${s(p.event_name)} has been cancelled.`, p.reason ? `Reason: ${s(p.reason)}` : ""].filter(Boolean)
		};
		case "event_updated": return {
			subject: `Event update: ${p.event_name}`,
			heading: "Event details changed",
			lines: [
				`The details for <strong>${s(p.event_name)}</strong> have changed:`,
				`<strong>Date:</strong> ${s(formatDate(p.starts_at, p.timezone))}`,
				`<strong>Venue:</strong> ${tba(p.venue_name)}${p.venue_city ? `, ${s(p.venue_city)}` : ""}`
			],
			action: eventLink ? {
				label: "View event",
				url: eventLink
			} : void 0
		};
		case "event_announcement": return {
			subject: `${p.event_name}: announcement`,
			heading: s(p.event_name),
			lines: [`Hi ${s(p.fighter_name)},`, s(p.message).replace(/\n/g, "<br>")],
			action: eventLink ? {
				label: "View event",
				url: eventLink
			} : void 0,
			footnote: "You can opt out of event announcements by replying \"unsubscribe\"."
		};
	}
	throw new Error(`Unknown email template: ${template}`);
}
/** Offer templates: only sent while the offer is still open; the action link is the fighter login page. */
const OFFER_LINK_TEMPLATES = /* @__PURE__ */ new Set(["bout_offer", "offer_expiry_reminder"]);
function renderEmail(template, payload, ctx) {
	const b = build(template, payload, ctx);
	const subject = b.subject.replace(/[\r\n]+/g, " ").slice(0, 200);
	const brand = s(ctx.orgName);
	return {
		subject,
		html: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>${s(subject)}</title></head>
<body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#121214;padding:18px 24px;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:1px;text-transform:uppercase">${brand}<span style="display:block;height:3px;width:40px;background:#dc2626;margin-top:8px"></span></td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 16px;font-size:22px;color:#121214">${b.heading}</h1>
${b.lines.map((l) => l.startsWith("<ul") ? l : `<p style="margin:0 0 12px;font-size:16px;line-height:1.5">${l}</p>`).join("\n")}
${b.action ? `<p style="margin:24px 0"><a href="${s(b.action.url)}" style="display:inline-block;background:#b91c1c;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px">${s(b.action.label)}</a></p><p style="font-size:12px;color:#71717a;word-break:break-all">${s(b.action.url)}</p>` : ""}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e4e4e7;font-size:12px;color:#71717a">${b.footnote ? s(b.footnote) + "<br>" : ""}Sent by ${brand}. This is an automated message about your registration or bouts.</td></tr>
</table></td></tr></table></body></html>`,
		text: [
			b.heading,
			"",
			...b.lines.map((l) => l.replace(/<li>/g, "- ").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")),
			b.action ? `\n${b.action.label}: ${b.action.url}` : "",
			"",
			`— ${ctx.orgName}`
		].join("\n")
	};
}
// supabase/functions/gmail-dispatch/index.ts
const json = (body, status = 200) => new Response(JSON.stringify(body), {
	status,
	headers: { "Content-Type": "application/json" }
});
function sameSecret(a, b) {
	if (!a || !b || a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
Deno.serve(async (req) => {
	const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
	const { data: cfgData, error: cfgErr } = await db.rpc("svc_email_config");
	if (cfgErr) return json({ error: "config_unavailable" }, 500);
	const cfg = cfgData;
	if (!sameSecret(req.headers.get("x-dispatch-secret") ?? "", cfg.dispatch_secret)) return json({ error: "unauthorized" }, 401);
	const user = Deno.env.get("GMAIL_USER");
	const pass = (Deno.env.get("GMAIL_APP_PASSWORD") ?? "").replace(/\s+/g, "");
	if (!user || !pass) return json({ error: "GMAIL_USER / GMAIL_APP_PASSWORD secrets are not set" }, 500);
	if (!cfg.site_url) return json({ error: "site_url is not set (run the SQL setup script)" }, 500);
	const siteUrl = cfg.site_url.replace(/\/$/, "");
	const mail = nodemailer.createTransport({
		host: "smtp.gmail.com",
		port: 465,
		secure: true,
		auth: {
			user,
			pass
		}
	});
	let sent = 0;
	let failed = 0;
	for (let round = 0; round < 3; round++) {
		const { data, error } = await db.rpc("svc_claim_emails", { p_limit: 10 });
		if (error) return json({ error: error.message }, 500);
		const rows = data ?? [];
		if (!rows.length) break;
		for (const row of rows) try {
			let actionUrl;
			if (OFFER_LINK_TEMPLATES.has(row.template)) {
				const { data: m } = await db.rpc("svc_offer_token_material", { p_offer: row.payload.offer_id });
				const mat = m;
				if (!mat || mat.status !== "pending") throw Object.assign(/* @__PURE__ */ new Error("Offer is no longer open; email not sent"), { permanent: true });
				actionUrl = `${siteUrl}/fighter`;
				row.payload.fighter_code ??= mat.fighter_code;
			}
			const msg = renderEmail(row.template, row.payload, {
				siteUrl,
				orgName: cfg.org_name,
				actionUrl
			});
			const info = await mail.sendMail({
				from: {
					name: cfg.org_name,
					address: user
				},
				to: row.to_name ? {
					name: row.to_name.replace(/[<>"]/g, ""),
					address: row.to_email
				} : row.to_email,
				subject: msg.subject,
				html: msg.html,
				text: msg.text
			});
			await db.rpc("svc_email_sent", {
				p_id: row.id,
				p_provider_id: info.messageId ?? `gmail-${row.id}`
			});
			sent++;
		} catch (e) {
			failed++;
			const code = e.responseCode ?? 0;
			const permanent = Boolean(e.permanent) || code >= 550 && code < 560;
			await db.rpc("svc_email_failed", {
				p_id: row.id,
				p_error: String(e.message).slice(0, 1e3),
				p_permanent: permanent
			});
		}
	}
	return json({
		sent,
		failed
	});
});
