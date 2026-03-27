# Operations — Iteology WhatsApp Connector

## Release checklist
1. Update add-on files in `baileys_bridge/`
2. Bump `version` in `baileys_bridge/config.json`
3. Add changelog entry in `config.json`
4. Commit + push to `main`
5. In HA, check for updates and rebuild/restart add-on

## Weekly checks
- Verify licensing API `/health`
- Verify PayPal webhook delivery
- Verify email delivery logs
- Verify active licenses/activations counts

## Monthly checks
- Review failed payments
- Review expired licenses and renewal prompts
- Publish small release notes/changelog

## Support triage
If user says "messages not sending":
1. Check add-on `/status` (license mode, paired state)
2. Confirm license active or trial active
3. Confirm send API returns 200 (not 403 license_required)
4. Confirm destination number format (MSISDN)
5. Check connector log and HA automation traces
