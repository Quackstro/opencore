# Healthcare Booking Skill

Autonomously book medical appointments by finding in-network providers, verifying coverage, and scheduling visits.

## Metadata

```yaml
domains:
  - healthcare
  - booking
  - medical
  - appointments
domainWeight: 0.9
capabilities:
  - tool-use
thinkingOverride: medium
thinkingOverrideMode: minimum
```

## Triggers

- "book a doctor appointment"
- "find a [specialist] near me"
- "schedule appointment with [specialty]"
- "orthopedic/dermatologist/PCP appointment"
- "who takes my insurance"
- "I need to see a doctor for [condition]"

## Patient Profile

Load from `assets/user-profile.yaml` or Brain. Required fields:

- Name (as on insurance card)
- Date of birth
- Phone number
- Insurance carrier, member ID, group number
- Location (ZIP codes, search radius)
- Reason for visit

## Autonomous Booking Workflow

### Phase 1: Gather Requirements

1. Check Brain for patient profile data
2. Confirm reason for visit and urgency
3. Identify required specialty
4. Get preferred timeframe and location constraints

### Phase 2: Provider Search

1. Query insurance directory (Aetna: https://www.aetna.com/dsepublic/)
2. Cross-reference with review sites (Healthgrades, Zocdoc)
3. Filter by:
   - Distance from patient ZIP
   - Accepting new patients
   - In-network for specific plan (PPO vs HMO)
   - Online scheduling availability
4. Rank by: reviews, distance, next availability

### Phase 3: Availability Check

Priority order:

1. **Online Portal** - Check practice website for patient portal booking
2. **Zocdoc/Healthgrades** - If practice listed, book directly
3. **Phone Call Script** - Use `references/phone-scripts.md` if manual booking needed

### Phase 4: Book Appointment

1. Select top provider (or ask user to choose from shortlist)
2. Attempt online booking if available
3. Gather appointment confirmation details:
   - Date and time
   - Provider name
   - Office address
   - Pre-visit requirements (forms, referral, imaging)
   - Copay estimate
4. Save to Brain for reminder scheduling

### Phase 5: Confirmation

1. Send appointment summary to user
2. Create reminder for appointment date
3. Note any pre-visit tasks (complete forms, get referral)

## Provider Search Commands

```bash
# Search Healthgrades for orthopedic surgeons near Riverview
curl "https://www.healthgrades.com/orthopedic-surgery-directory/fl-florida/riverview"

# Alternative: Use web_fetch tool
web_fetch url="https://www.healthgrades.com/orthopedic-surgery-directory/fl-florida/riverview"
```

## Phone Booking Fallback

If online booking unavailable, generate call script:

```
Hi, I'd like to schedule a new patient appointment.

Patient: Jose G Castro
DOB: December 13, 1981
Phone: 678-575-3122
Insurance: Aetna Open Choice PPO
Member ID: W172639058
Group #: 0863775-010-00003

Reason: Knee pain

Do you have availability next week?
```

## Files

- `assets/user-profile.yaml` - Patient info (populated)
- `references/insurance-directories.md` - Carrier lookup URLs
- `references/phone-scripts.md` - Call templates
- `references/booking-checklist.md` - Pre-booking verification steps

## Notes

- Always verify insurance acceptance before booking
- PPO plans typically don't need specialist referrals
- Save all appointment details to Brain
- Create reminders 24h and 1h before appointment
- If patient has multiple insurance options, use primary listed in profile
