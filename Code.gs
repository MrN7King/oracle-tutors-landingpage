/**
 * ====================================================================
 * Oracle Tutors — combined form backend (quick-match + careers/CV)
 * ====================================================================
 * ONE script, ONE deployment, ONE Sheet (with two tabs) handling
 * BOTH forms on the site:
 *   - The quick-match form on index.html (name/email/role/subject/level)
 *   - The careers application form on careers.html (name/email/role/
 *     message/CV)
 *
 * It tells the two apart automatically: only the careers form ever
 * sends a "cvBase64" field, so doPost() checks for that and routes
 * to the right handler. You do NOT need two Sheets, two Apps Script
 * projects, or two deployments — use the SAME Web App URL in both
 * index.html's SCRIPT_URL and careers.html's SCRIPT_URL.
 *
 * QUICK-MATCH FLOW (index.html):
 *   1. Validate required fields (name, email, role, subject).
 *   2. Append a row to the "Submissions" tab.
 *   3. Email the visitor a confirmation.
 *   4. Email you a notification.
 *
 * CAREERS FLOW (careers.html):
 *   1. Validate required fields (name, email, role, message, CV).
 *   2. Decode the base64 CV into a real file, save it to a Drive
 *      folder (permanent copy + avoids Gmail's attachment limit).
 *   3. Append a row to the "Applications" tab with a link to that file.
 *   4. Email you a notification with the CV attached directly.
 *   5. Email the applicant a confirmation.
 *
 * SETUP:
 *   1. Create ONE new Google Sheet. You don't need to create the
 *      tabs yourself — both "Submissions" and "Applications" tabs
 *      are created automatically the first time each form is used.
 *   2. Extensions → Apps Script, delete the placeholder code, paste
 *      this whole file in.
 *   3. Change OWNER_EMAIL below to your real inbox.
 *   4. Deploy → New deployment → type "Web app" → Execute as "Me" →
 *      Who has access "Anyone" → Deploy. Authorize when prompted
 *      (you'll see a Google warning screen since this is your own
 *      unverified script — click Advanced → Go to [project] to
 *      proceed).
 *   5. Copy the "Web app URL" it gives you and paste that SAME URL
 *      into SCRIPT_URL in BOTH index.html and careers.html.
 * ====================================================================
 */

// ---- CONFIG — edit these lines ----
var OWNER_EMAIL = 'oracletutorscenter@gmail.com';
var BUSINESS_NAME = 'Oracle Tutors';
var REPLY_WINDOW = '24 hours'; // used in the quick-match confirmation only

var QUICKMATCH_SHEET_NAME = 'Submissions';
var CAREERS_SHEET_NAME = 'Applications';
var DRIVE_FOLDER_NAME = 'Oracle Tutors — CVs';

// Gmail attachment limit is 25MB; the careers form already caps
// uploads at 5MB client-side, but we re-check server-side too since
// client-side checks can always be bypassed.
var MAX_CV_BYTES = 5 * 1024 * 1024;

/**
 * Single entry point Google calls whenever the deployed Web App
 * receives a POST request — both index.html's and careers.html's
 * fetch() calls hit this same function. We route based on payload
 * shape: only the careers form ever includes cvBase64.
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    var data = parseRequestBody(e);
    var isCareersSubmission = !!data.cvBase64;

    return isCareersSubmission
      ? handleCareersSubmission(data)
      : handleQuickMatchSubmission(data);
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ====================================================================
// QUICK-MATCH FORM (index.html)
// ====================================================================

function handleQuickMatchSubmission(data) {
  var name = cleanString(data.name);
  var email = cleanString(data.email);
  var role = cleanString(data.role);
  var subject = cleanString(data.subject);
  var level = cleanString(data.level);

  if (!name || !email || !role || !subject) {
    return jsonResponse({ ok: false, error: 'Missing required fields.' });
  }
  if (!isValidEmail(email)) {
    return jsonResponse({ ok: false, error: 'Invalid email address.' });
  }

  appendQuickMatchSubmission(name, email, role, subject, level);
  sendQuickMatchConfirmation(name, email, role, subject, level);
  if (OWNER_EMAIL) {
    sendQuickMatchOwnerNotification(name, email, role, subject, level);
  }

  return jsonResponse({ ok: true });
}

function appendQuickMatchSubmission(name, email, role, subject, level) {
  var sheet = getOrCreateSheet(QUICKMATCH_SHEET_NAME,
    ['Timestamp', 'Name', 'Email', 'Booking for', 'Subject', 'Level']);
  sheet.appendRow([new Date(), name, email, role, subject, level]);
}

/** The auto-reply the visitor sees — this is the "please check your
 *  email" promise the website makes them. */
function sendQuickMatchConfirmation(name, email, role, subject, level) {
  var subjectLine = "We've got your request, " + name + "! 🎓";
  var levelLine = level ? (' (' + level + ')') : '';

  var body =
    'Hi ' + name + ',\n\n' +
    'Thanks for reaching out to ' + BUSINESS_NAME + '! We\'ve received your request for a ' +
    subject + ' tutor' + levelLine + ' for ' + role + '.\n\n' +
    'A real person from our team will personally follow up at this email address within ' +
    REPLY_WINDOW + ' with a hand-picked tutor match.\n\n' +
    'If you don\'t see our reply, please check your spam or promotions folder.\n\n' +
    'Talk soon,\n' +
    'The ' + BUSINESS_NAME + ' Team';

  MailApp.sendEmail({ to: email, subject: subjectLine, body: body, name: BUSINESS_NAME });
}

/** Optional: pings you so you don't have to keep checking the sheet. */
function sendQuickMatchOwnerNotification(name, email, role, subject, level) {
  var body =
    'New tutoring request:\n\n' +
    'Name: ' + name + '\n' +
    'Email: ' + email + '\n' +
    'Booking for: ' + role + '\n' +
    'Subject: ' + subject + '\n' +
    'Level: ' + (level || '—') + '\n';

  MailApp.sendEmail({ to: OWNER_EMAIL, subject: 'New match request — ' + name, body: body });
}

// ====================================================================
// CAREERS APPLICATION FORM (careers.html)
// ====================================================================

function handleCareersSubmission(data) {
  var name = cleanString(data.name);
  var email = cleanString(data.email);
  var role = cleanString(data.role);
  var message = cleanString(data.message);
  var cvFileName = cleanString(data.cvFileName) || 'cv';
  var cvMimeType = cleanString(data.cvMimeType) || 'application/octet-stream';
  var cvBase64 = data.cvBase64 || '';

  if (!name || !email || !role || !message) {
    return jsonResponse({ ok: false, error: 'Missing required fields.' });
  }
  if (!isValidEmail(email)) {
    return jsonResponse({ ok: false, error: 'Invalid email address.' });
  }
  if (!cvBase64) {
    return jsonResponse({ ok: false, error: 'Missing CV file.' });
  }

  var cvBlob = base64ToBlob(cvBase64, cvMimeType, cvFileName);
  if (!cvBlob) {
    return jsonResponse({ ok: false, error: 'Could not read the CV file.' });
  }
  if (cvBlob.getBytes().length > MAX_CV_BYTES) {
    return jsonResponse({ ok: false, error: 'CV file is too large.' });
  }

  var driveFile = saveCvToDrive(cvBlob, name);
  appendCareersApplication(name, email, role, message, driveFile.getUrl());
  sendCareersOwnerNotification(name, email, role, message, driveFile, cvBlob);
  sendCareersApplicantConfirmation(name, email, role);

  return jsonResponse({ ok: true });
}

/** Turns the base64 string the browser sent back into a real Blob
 *  (Apps Script's file object) we can save to Drive or attach to an
 *  email. Returns null if the base64 data is malformed. */
function base64ToBlob(base64, mimeType, fileName) {
  try {
    var bytes = Utilities.base64Decode(base64);
    return Utilities.newBlob(bytes, mimeType, fileName);
  } catch (err) {
    return null;
  }
}

/** Saves the CV into a dedicated Drive folder (created on first run)
 *  and returns the resulting Drive File, so we always keep a
 *  permanent copy even if an email attachment ever gets missed or
 *  filtered. */
function saveCvToDrive(cvBlob, applicantName) {
  var folder = getOrCreateDriveFolder();
  var timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var safeName = applicantName.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Applicant';
  cvBlob.setName(timestamp + ' — ' + safeName + ' — ' + cvBlob.getName());
  var file = folder.createFile(cvBlob);
  // Anyone with the link can view — makes the Sheet link clickable
  // for anyone on your team without extra sharing steps.
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file;
}

function getOrCreateDriveFolder() {
  var folders = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(DRIVE_FOLDER_NAME);
}

function appendCareersApplication(name, email, role, message, cvDriveUrl) {
  var sheet = getOrCreateSheet(CAREERS_SHEET_NAME,
    ['Timestamp', 'Name', 'Email', 'Role', 'Message', 'CV (Drive link)']);
  sheet.appendRow([new Date(), name, email, role, message, cvDriveUrl]);
}

/** Notifies you with the CV attached directly to the email, so you
 *  can review an application without leaving your inbox. */
function sendCareersOwnerNotification(name, email, role, message, driveFile, cvBlob) {
  var body =
    'New application:\n\n' +
    'Name: ' + name + '\n' +
    'Email: ' + email + '\n' +
    'Role: ' + role + '\n\n' +
    'Message:\n' + message + '\n\n' +
    'CV is attached to this email, and also saved here: ' + driveFile.getUrl();

  MailApp.sendEmail({
    to: OWNER_EMAIL,
    subject: 'New application — ' + name + ' (' + role + ')',
    body: body,
    attachments: [cvBlob],
    name: BUSINESS_NAME
  });
}

/** The auto-reply the applicant sees, confirming their CV actually
 *  made it through. */
function sendCareersApplicantConfirmation(name, email, role) {
  var subjectLine = "We've got your application, " + name + "! 🎓";
  var body =
    'Hi ' + name + ',\n\n' +
    'Thanks for applying to ' + BUSINESS_NAME + ' for the ' + role + ' role — ' +
    'your application and CV came through successfully.\n\n' +
    'We read every application ourselves and will follow up by email, usually within a few days.\n\n' +
    'Talk soon,\n' +
    'The ' + BUSINESS_NAME + ' Team';

  MailApp.sendEmail({ to: email, subject: subjectLine, body: body, name: BUSINESS_NAME });
}

// ====================================================================
// SHARED HELPERS
// ====================================================================

/**
 * The browser sends the JSON body as Content-Type: text/plain (to
 * dodge a CORS preflight), so we parse it from e.postData.contents
 * rather than e.parameter.
 */
function parseRequestBody(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    return {};
  }
}

function cleanString(value) {
  return (value === undefined || value === null) ? '' : String(value).trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Gets (or creates, with a header row) a tab in the ACTIVE Sheet —
 *  the one this script is bound to. Both forms share this one Sheet
 *  file, just different tabs. */
function getOrCreateSheet(sheetName, headerRow) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(headerRow);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Optional helper — run this once manually from the Apps Script
 * editor (select doGetTest in the function dropdown, click Run) to
 * confirm MailApp/Drive access works and check your remaining daily
 * email quota.
 */
function doGetTest() {
  Logger.log('Remaining email quota today: ' + MailApp.getRemainingDailyQuota());
  Logger.log('CV folder: ' + getOrCreateDriveFolder().getUrl());
}