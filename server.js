const express = require('express');
const mongoose = require('mongoose');
const pino = require('pino');
const NodeCache = require('node-cache');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('baileys');
const { createClient } = require('@supabase/supabase-js');
const { Mutex } = require('async-mutex');
const config = require('./config');
const path = require('path');

const app = express();
const port = config.PORT || 3000;
const msgRetryCounterCache = new NodeCache();
const mutex = new Mutex();
let session;

// Initialize Supabase client
const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);

// Define Mongoose Session Schema
const sessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true },
    data: { type: Object, required: true },
    createdAt: { type: Date, default: Date.now }
});

// Create Session model
const Session = mongoose.model('Session', sessionSchema);

// Connect to MongoDB with Mongoose
async function connectToMongo() {
    try {
        const mongoUri = 'mongodb+srv://Alya:Alya2006@alya.wnpwwot.mongodb.net/whatsapp_sessions?retryWrites=true&w=majority&appName=Alya';
        
        await mongoose.connect(mongoUri);
        
        console.log('Connected to MongoDB with Mongoose');
    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
}
connectToMongo();

app.use(express.static(path.join(__dirname, 'public')));

// Function to save session to MongoDB
async function saveSessionToMongo(sessionData) {
    try {
        const sessionId = Date.now().toString();
        const newSession = new Session({
            sessionId,
            data: sessionData
        });
        
        await newSession.save();
        return sessionId;
    } catch (error) {
        console.error('MongoDB save error:', error);
        throw error;
    }
}

// Function to upload session to Supabase from MongoDB
async function uploadSessionToSupabase(sessionId) {
    try {
        const sessionData = await Session.findOne({ sessionId });
        
        if (!sessionData) {
            throw new Error('Session not found in MongoDB');
        }
        
        // Convert session data to a buffer (simulating file content)
        const fileContent = Buffer.from(JSON.stringify(sessionData.data));
        const fileName = `${sessionId}.json`;
        
        const { error } = await supabase.storage
            .from('sessions')
            .upload(fileName, fileContent);
        
        if (error) throw error;
        
        return sessionId;
    } catch (error) {
        console.error('Supabase upload error:', error);
        throw error;
    }
}

// WhatsApp connection handler
async function connector(phoneNumber, res) {
    // Create a virtual session storage using MongoDB
    const virtualSessionDir = {
        readFile: async (file) => {
            const sessionData = await Session.findOne({ sessionId: file });
            return sessionData ? Buffer.from(JSON.stringify(sessionData.data)) : null;
        },
        writeFile: async (file, data) => {
            await Session.findOneAndUpdate(
                { sessionId: file },
                { data: JSON.parse(data.toString()) },
                { upsert: true, new: true }
            );
        },
        removeFile: async (file) => {
            await Session.deleteOne({ sessionId: file });
        },
        readDir: async () => {
            const sessions = await Session.find({}, 'sessionId');
            return sessions.map(s => s.sessionId);
        }
    };

    const { state, saveCreds } = await useMultiFileAuthState(virtualSessionDir);

    session = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' }))
        },
        logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
        browser: Browsers.macOS("Safari"),
        markOnlineOnConnect: true,
        msgRetryCounterCache
    });

    if (!session.authState.creds.registered) {
        await delay(1500);
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const code = await session.requestPairingCode(cleanNumber);
        
        if (!res.headersSent) {
            res.json({ 
                success: true,
                code: code?.match(/.{1,4}/g)?.join('-'),
                message: 'Use this code to pair your device'
            });
        }
    }

    session.ev.on('creds.update', saveCreds);

    session.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') {
            console.log('WhatsApp connected successfully');
            await delay(5000);
            
            try {
                // Save session to MongoDB
                const sessionId = await saveSessionToMongo(state);
                
                // Upload to Supabase
                const fullSessionId = config.PREFIX + sessionId;
                await uploadSessionToSupabase(sessionId);
                
                // Send confirmation with session ID
                await session.sendMessage(session.user.id, { 
                    text: `*Session ID*\n\n${fullSessionId}\n\n${config.MESSAGE}`
                });
                
                if (config.IMAGE) {
                    await session.sendMessage(session.user.id, { 
                        image: { url: config.IMAGE },
                        caption: 'Your session has been created successfully!'
                    });
                }
            } catch (error) {
                console.error('Session handling error:', error);
            } finally {
                session.end();
            }
        } else if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            handleDisconnect(reason);
        }
    });
}

function handleDisconnect(reason) {
    if ([DisconnectReason.connectionLost, DisconnectReason.connectionClosed, DisconnectReason.restartRequired].includes(reason)) {
        console.log('Connection lost, attempting to reconnect...');
        connector();
    } else {
        console.log(`Disconnected! Reason: ${reason}`);
        if (session) session.end();
    }
}

// Pairing endpoint
app.get('/pair', async (req, res) => {
    const phoneNumber = req.query.number;
    if (!phoneNumber) {
        return res.status(400).json({ 
            success: false,
            error: 'Phone number is required'
        });
    }
  
    const release = await mutex.acquire();
    try {
        await connector(phoneNumber, res);
    } catch (error) {
        console.error('Pairing error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to generate pairing code'
        });
    } finally {
        release();
    }
});

// Default route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// Close Mongoose connection on process exit
process.on('SIGINT', async () => {
    await mongoose.connection.close();
    process.exit();
});