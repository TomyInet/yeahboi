const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const mongoose = require('mongoose');
const fetch = require('node-fetch');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

console.log('STARTUP:', 'cwd', process.cwd(), '__dirname', __dirname, 'MONGODB_URI set?', !!process.env.MONGODB_URI);

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'attendance_system';
const JWT_SECRET = process.env.JWT_SECRET || 'replace_this_secret_in_production';

if (!MONGODB_URI || MONGODB_URI.includes('YOUR_PASSWORD') || MONGODB_URI.includes('YOUR_NEW_SECURE_PASSWORD')) {
    console.error('Invalid MONGODB_URI: please set a real MongoDB connection string in .env and restart.');
    process.exit(1);
}

app.get('/health', (req, res) => {
    return res.json({
        status: 'ok',
        port: process.env.PORT || 8080,
        dbUriSet: !!MONGODB_URI,
        cwd: process.cwd(),
        dirname: __dirname,
    });
});
const ADMIN_USERS = (process.env.ADMIN_USERS || 'cruz,lorzano,comia')
    .split(',')
    .map((username) => username.trim().toLowerCase())
    .filter(Boolean);
const SPREADSHEET_ID = '1nAHAZDbqU6dXj7-qCjNWsy4yfKBgRRqJM5bfJwmI0Mw';
const CREDENTIALS_FILE = path.join(__dirname, 'credentials.json');
const SHEETS = [
    { name: 'Attendance boys', gid: '1508453331' },
    { name: 'Attendance girls', gid: '1571274624' },
];
const SCAN_LOG_SHEET = 'SCAN LOGS';
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1517451620336799764/xhkn2_Sz_4dqFxfHIYtVIzPPdB8NVaH27rY6WDXGCQUMxRofrXJB4e_z3Pw7peCZl1Ai';
const ATTENDANCE_START_COLUMN = 3; // C
const ATTENDANCE_END_COLUMN = 33; // AG
const ROW_START = 9;
const ROW_END = 38;
const DATE_HEADER_ROW = 8;
const ALLOWED_MARKS = ['/', 'L', 'X', 'E'];

if (!MONGODB_URI) {
    console.error('Missing required environment variable: MONGODB_URI');
    process.exit(1);
}

let db;
let rosterCollection;
let scanLogCollection;
let attendanceCollection;

const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheetsService = google.sheets({ version: 'v4', auth });

async function connectDb() {
    await mongoose.connect(MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        dbName: DB_NAME,
    });

    db = mongoose.connection.db;
    rosterCollection = db.collection('Database');
    scanLogCollection = db.collection('Scan Logs');
    attendanceCollection = db.collection('Attendance');

    await Promise.all([
        rosterCollection.createIndex({ _id: 1 }, { unique: true }),
        attendanceCollection.createIndex({ studentId: 1 }, { unique: true }),
        scanLogCollection.createIndex({ studentId: 1, timestamp: 1 }),
    ]);

    console.log('✅ MongoDB connected to', DB_NAME);
}

function getManilaDate() {
    const now = new Date();
    const manila = now.toLocaleString('en-US', { timeZone: 'Asia/Manila' });
    return new Date(manila);
}

function getTodayDateString() {
    const manilaDate = getManilaDate();
    return manilaDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getTimestamp() {
    const manilaDate = getManilaDate();
    const year = manilaDate.getFullYear();
    const month = String(manilaDate.getMonth() + 1).padStart(2, '0');
    const day = String(manilaDate.getDate()).padStart(2, '0');
    const hours = String(manilaDate.getHours()).padStart(2, '0');
    const minutes = String(manilaDate.getMinutes()).padStart(2, '0');
    const seconds = String(manilaDate.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function getDisplayTime() {
    const manilaDate = getManilaDate();
    return manilaDate.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    });
}

function attendanceMarkFromTime() {
    const manilaDate = getManilaDate();
    const hours = manilaDate.getHours();
    const minutes = manilaDate.getMinutes();
    if (hours < 6 || (hours === 6 && minutes <= 30)) {
        return '/';
    }
    return 'L';
}

function statusTextFromMark(mark) {
    switch (mark) {
        case '/':
            return 'Present';
        case 'L':
            return 'Late';
        case 'X':
            return 'Absent';
        case 'E':
            return 'Excused';
        default:
            return 'Unknown';
    }
}

async function appendScanLogSheet({ timestamp, studentId, name, status }) {
    try {
        await sheetsService.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SCAN_LOG_SHEET}!A:D`,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[timestamp, studentId, name || '', status]],
            },
        });
    } catch (err) {
        console.error('Failed to append scan log to sheet:', err);
    }
}

async function sendDiscordNotification({ studentName, studentId, scanTime, attendanceStatus }) {
    try {
        await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                embeds: [
                    {
                        title: 'Attendance Scan Recorded',
                        color: 3066993,
                        fields: [
                            { name: 'Student Name', value: studentName || 'Unknown', inline: true },
                            { name: 'LRN / ID', value: studentId || 'Unknown', inline: true },
                            { name: 'Scan Time', value: scanTime || 'Unknown', inline: false },
                            { name: 'Attendance Status', value: attendanceStatus || 'Unknown', inline: true },
                        ],
                        timestamp: new Date().toISOString(),
                    },
                ],
            }),
        });
    } catch (err) {
        console.error('Discord webhook failed:', err);
    }
}

function columnNumberToLetter(number) {
    let letter = '';
    let num = number;
    while (num > 0) {
        const remainder = (num - 1) % 26;
        letter = String.fromCharCode(65 + remainder) + letter;
        num = Math.floor((num - 1) / 26);
    }
    return letter;
}

function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.admin = payload;
        return next();
    } catch (err) {
        return res.status(401).json({ status: 'error', message: 'Invalid token' });
    }
}

async function findStudentInSheets(studentId) {
    for (const sheet of SHEETS) {
        const range = `${sheet.name}!A${ROW_START}:B${ROW_END}`;
        const response = await sheetsService.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range,
        });
        const rows = response.data.values || [];

        for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index];
            const rowId = (row[0] || '').toString().trim();
            const rowName = (row[1] || '').toString().trim();
            if (rowId === studentId) {
                return {
                    sheetName: sheet.name,
                    rowNumber: ROW_START + index,
                    studentId: rowId,
                    studentName: rowName,
                };
            }
        }
    }
    return null;
}

async function getOrCreateDateColumn(sheetName, dateLabel) {
    const startLetter = columnNumberToLetter(ATTENDANCE_START_COLUMN);
    const endLetter = columnNumberToLetter(ATTENDANCE_END_COLUMN);
    const range = `${sheetName}!${startLetter}${DATE_HEADER_ROW}:${endLetter}${DATE_HEADER_ROW}`;
    const response = await sheetsService.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range,
    });
    const header = response.data.values?.[0] || [];
    const existingIndex = header.findIndex((cell) => (cell || '').toString().trim() === dateLabel);
    if (existingIndex !== -1) {
        return ATTENDANCE_START_COLUMN + existingIndex;
    }

    const emptyIndex = header.findIndex((cell) => !cell || String(cell).trim() === '');
    if (emptyIndex !== -1) {
        const writeIndex = ATTENDANCE_START_COLUMN + emptyIndex;
        const writeColumn = columnNumberToLetter(writeIndex);
        await sheetsService.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${sheetName}!${writeColumn}${DATE_HEADER_ROW}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[dateLabel]] },
        });
        return writeIndex;
    }

    throw new Error('Attendance date header row is full.');
}

async function markAttendanceCell(sheetName, rowNumber, dateLabel, mark) {
    const columnIndex = await getOrCreateDateColumn(sheetName, dateLabel);
    const columnLetter = columnNumberToLetter(columnIndex);
    await sheetsService.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!${columnLetter}${rowNumber}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[mark]] },
    });
}

app.post('/api/auth/login', (req, res) => {
    const { username } = req.body;
    if (!username) {
        return res.status(400).json({ status: 'error', message: 'Last name is required' });
    }

    const normalized = username.trim().toLowerCase();
    if (!ADMIN_USERS.includes(normalized)) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized admin' });
    }

    const token = jwt.sign({ username: normalized }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ status: 'success', token, name: username.trim() });
});

app.get('/api/auth/status', requireAuth, (req, res) => {
    return res.json({ status: 'success', admin: req.admin.username });
});

app.post('/api/students/add', requireAuth, async (req, res) => {
    const { studentId, name } = req.body;
    if (!studentId || !name) {
        return res.status(400).json({ status: 'error', message: 'studentId and name are required' });
    }

    const trimmedId = studentId.trim();
    const trimmedName = name.trim();
    if (!trimmedId || !trimmedName) {
        return res.status(400).json({ status: 'error', message: 'Valid studentId and name are required' });
    }

    try {
        await rosterCollection.updateOne(
            { _id: trimmedId },
            {
                $set: { name: trimmedName, updatedAt: new Date() },
                $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true }
        );

        await attendanceCollection.updateOne(
            { studentId: trimmedId },
            {
                $setOnInsert: {
                    studentId: trimmedId,
                    name: trimmedName,
                    attendanceHistory: [],
                    createdAt: new Date(),
                },
                $set: { name: trimmedName },
            },
            { upsert: true }
        );

        return res.json({ status: 'success', studentId: trimmedId, name: trimmedName });
    } catch (err) {
        console.error('Student registration error:', err);
        return res.status(500).json({ status: 'error', message: 'Failed to register student' });
    }
});

app.post('/api/scan', requireAuth, async (req, res) => {
    const { studentId, mark } = req.body;
    if (!studentId) {
        return res.status(400).json({ status: 'error', message: 'No ID provided' });
    }

    const trimmedId = studentId.trim();
    if (!trimmedId) {
        return res.status(400).json({ status: 'error', message: 'Invalid ID' });
    }

    const computedMark = typeof mark === 'string' && mark.trim() !== ''
        ? mark.trim().toUpperCase()
        : attendanceMarkFromTime();

    if (!ALLOWED_MARKS.includes(computedMark)) {
        return res.status(400).json({ status: 'error', message: 'Invalid attendance mark' });
    }

    try {
        const sheetEntry = await findStudentInSheets(trimmedId);
        if (!sheetEntry) {
            const notFoundStatus = 'Not Found';
            await scanLogCollection.insertOne({
                studentId: trimmedId,
                name: null,
                statusText: notFoundStatus,
                date: getTodayDateString(),
                timestamp: new Date(),
            });
            await appendScanLogSheet({
                timestamp: getTimestamp(),
                studentId: trimmedId,
                name: null,
                status: notFoundStatus,
            });
            return res.json({ status: 'not_found' });
        }

        const studentName = sheetEntry.studentName || trimmedId;
        const today = getTodayDateString();
        const timestamp = getTimestamp();
        const displayTime = getDisplayTime();
        const attendanceStatus = statusTextFromMark(computedMark);

        await markAttendanceCell(sheetEntry.sheetName, sheetEntry.rowNumber, today, computedMark);

        await scanLogCollection.insertOne({
            studentId: sheetEntry.studentId,
            name: studentName,
            sheet: sheetEntry.sheetName,
            rowNumber: sheetEntry.rowNumber,
            mark: computedMark,
            statusText: attendanceStatus,
            date: today,
            timestamp: new Date(),
            formattedTimestamp: timestamp,
        });

        await appendScanLogSheet({
            timestamp,
            studentId: sheetEntry.studentId,
            name: studentName,
            status: attendanceStatus,
        });

        const attendanceDoc = await attendanceCollection.findOne({ studentId: sheetEntry.studentId });
        const alreadyPresent = attendanceDoc?.attendanceHistory?.some((entry) => entry.date === today);

        await attendanceCollection.updateOne(
            { studentId: sheetEntry.studentId },
            {
                $set: {
                    name: studentName,
                    lastSeen: new Date(),
                },
                $addToSet: {
                    attendanceHistory: { date: today, mark: computedMark },
                },
            },
            { upsert: true }
        );

        sendDiscordNotification({
            studentName,
            studentId: sheetEntry.studentId,
            scanTime: `${today} ${displayTime}`,
            attendanceStatus,
        }).catch(() => {
            // Fire-and-forget; errors already logged.
        });

        return res.json({
            status: alreadyPresent ? 'duplicate' : 'success',
            name: studentName,
            time: displayTime,
            sheet: sheetEntry.sheetName,
            mark: computedMark,
            attendanceStatus,
        });
    } catch (err) {
        console.error('Scan processing error:', err);
        return res.status(500).json({ status: 'error', message: 'Failed to process scan' });
    }
});

const PORT = process.env.PORT || 8080;

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});

connectDb()
    .then(() => {
        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Attendance server running on port ${PORT} (bound to 0.0.0.0)`);
        });

        server.on('error', (err) => {
            console.error('Server listen error:', err);
            if (err.code === 'EACCES') {
                console.error(`Port ${PORT} requires elevated privileges. Try using a higher port like 8080 or run as administrator.`);
            } else if (err.code === 'EADDRINUSE') {
                console.error(`Port ${PORT} is already in use. Use a different PORT environment variable.`);
            }
            process.exit(1);
        });
    })
    .catch((err) => {
        console.error('Unable to connect to MongoDB:', err);
        process.exit(1);
    });