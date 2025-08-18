const express = require('express');
const fs = require('fs');
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

app.use(express.static(path.join(__dirname, 'public')));

// Function to upload session folder to Supabase
async function uploadSession(sessionDir) {
    try {
        const files = fs.readdirSync(sessionDir);
        const sessionId = Date.now().toString(); // Unique ID for the session
        
        // Upload each file in the session directory
        for (const file of files) {
            const filePath = path.join(sessionDir, file);
            const fileContent = fs.readFileSync(filePath);
            
            const { error } = await supabase.storage
                .from('sessions')
                .upload(`${sessionId}/${file}`, fileContent);
            
            if (error) throw error;
        }
        
        return sessionId;
    } catch (error) {
        console.error('Supabase upload error:', error);
        throw error;
    }
}

// WhatsApp connection handler
async function connector(phoneNumber, res) {
    const sessionDir = './temp_session';
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir);
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

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
                // Upload session to Supabase
                const sessionId = await uploadSession(sessionDir);
                const fullSessionId = config.PREFIX + sessionId;
                
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
                // Clean up session files
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
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