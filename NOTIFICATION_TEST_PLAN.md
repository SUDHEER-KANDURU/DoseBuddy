# DoseBuddy Notification System - Comprehensive Test Plan

## Quick Verification Tests (5 minutes)

### 1. Audio System Test
```javascript
// Run in browser console after login
testMissedDoseSound()
```
**Expected Result**: Should hear the notify-sound.mp3 file play at full volume

### 2. Scheduler Status Test  
```javascript
// Run in browser console
testSchedulerDebug()
```
**Expected Result**: Should show user logged in, medications loaded, and active timers

### 3. Permission Test
```javascript
// Run in browser console
Notification.requestPermission().then(perm => console.log('Permission:', perm))
```
**Expected Result**: Should return "granted" or prompt user for permission

## Full Integration Test (15 minutes)

### Test Setup
1. Login to DoseBuddy
2. Go to "Add Medicine" section
3. Create test medicine:
   - Name: "Test Medicine"
   - Dosage: "1 tablet"  
   - Time: Set to 2 minutes from current time
   - Start date: Today
   - End date: Today

### Test Sequence

#### Phase 1: Reminder Notification (At scheduled time)
**Expected Behaviors**:
- Browser notification appears: "Dose Reminder: Test Medicine"  
- Sound plays (notify-sound.mp3 at 0.8 volume)
- Dashboard shows "Due now" status with yellow background
- Console logs show "REMINDER SOUND FIRED"

#### Phase 2: Grace Period (0-60 seconds after scheduled time)  
**Expected Behaviors**:
- Status remains "Due now"
- No missed notifications yet
- Can still mark as taken normally

#### Phase 3: Missed Detection (61+ seconds after scheduled time)
**Expected Behaviors**:
1. **Sound**: notify-sound.mp3 plays at full volume (1.0)
2. **Browser Notification**: "Missed dose: Test Medicine" appears
3. **Dashboard Status**: Changes from "Due now" to "Missed" (red background)
4. **In-App Notification**: New entry appears in notification center bell icon
5. **Console Logs**: Shows "MISSED DOSE SOUND FIRED" and "PROCESSING MISSED"

### Verification Checklist

#### Audio Verification ✓
- [ ] Reminder sound plays at dose time
- [ ] Missed dose sound plays at 1 minute after
- [ ] Sound volume is audible (not muted/blocked)
- [ ] Can hear difference between reminder and missed sound timing

#### Browser Notification Verification ✓  
- [ ] Dose reminder notification at scheduled time
- [ ] Missed dose notification at 1 minute after
- [ ] Notifications show correct medicine name and time
- [ ] Clicking notification opens/focuses DoseBuddy tab

#### Status Change Verification ✓
- [ ] Status starts as "Pending" before dose time  
- [ ] Changes to "Due now" at exact dose time
- [ ] Changes to "Missed" at exactly 1 minute after
- [ ] Dashboard cell updates in real-time (no refresh needed)

#### In-App Notification Verification ✓
- [ ] Notification bell icon shows count badge
- [ ] Missed dose entry appears in notification panel
- [ ] Entry shows medicine name and scheduled time
- [ ] Multiple missed doses accumulate in list

## Extended Production Test (24 hours)

### Multi-Medicine Test
1. Create 3-4 medicines with different times throughout the day
2. Let some be taken on time, others missed
3. Verify each medicine triggers notifications correctly
4. Check that notification deduplication works (no duplicates)

### Edge Cases Test
1. **Page Refresh**: Refresh browser during grace period, verify missed detection continues
2. **Tab Background**: Put tab in background, verify notifications still work  
3. **Multiple Tabs**: Open multiple DoseBuddy tabs, verify no duplicate sounds
4. **Browser Restart**: Close and reopen browser, verify system still works

### Performance Test
1. Monitor browser console for errors over 24 hours
2. Check that memory usage doesn't grow unbounded
3. Verify notification system works after prolonged use

## Troubleshooting Guide

### No Sound Playing
**Check**:
- Is notify-sound.mp3 accessible? Visit: `[your-domain]/notify-sound.mp3`
- Console error: "No notify-sound element found"?
- Audio permissions blocked by browser?
- **Fix**: Run `testMissedDoseSound()` to diagnose audio issues

### No Browser Notifications
**Check**:
- Notification permission granted?
- Service Worker registered? Check Application tab in DevTools
- Console error: "Service Worker registration failed"?
- **Fix**: Run permission test and check SW registration

### Status Not Changing to Missed
**Check**:  
- Medicine schedule active for today?
- Console shows "checkReminders" running every 15 seconds?
- Backend API calls succeeding?
- **Fix**: Run `testSchedulerDebug()` to check scheduler state

### Timing Issues
**Check**:
- System clock accurate?  
- Grace period set to 1 minute (MISSED_GRACE_MIN = 1)?
- Console shows exact timing logs?
- **Fix**: Check console timestamps and compare to system time

## Console Log Patterns (Success)

### At Dose Time (Reminder)
```
[DoseBuddy] triggerDoseNotification — med:"Test Medicine" time:14:30
[DoseBuddy Audio] REMINDER SOUND FIRED (notify-sound.mp3)
[DoseBuddy Notifications] ✓ Service Worker notification sent successfully
```

### At 1 Minute After (Missed)
```
[DoseBuddy CheckReminders] Test Medicine at 14:30: 1 minutes late  
[DoseBuddy CheckReminders] PROCESSING MISSED: Test Medicine (1 min late)
[DoseBuddy Audio] ✓ MISSED DOSE SOUND PLAYED (notify-sound.mp3)
[DoseBuddy CheckReminders] ✓ Browser notification sent successfully
[DoseBuddy CheckReminders] Updated dashboard cell to MISSED
```

## Success Criteria

**✅ PASS Criteria**: All three core requirements work correctly:
1. In-app notification center receives missed dose entries ✓
2. Browser notifications fire at exact times ✓  
3. Status changes "Due now" → "Missed" at 1 minute ✓

**❌ FAIL Criteria**: Any of the three core requirements doesn't work

---

**Test Status**: Ready for production verification
**Estimated Test Time**: 5 min quick test + 15 min full test + 24hr extended test