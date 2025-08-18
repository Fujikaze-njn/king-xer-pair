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
const { put } = require('@vercel/blob');
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

// WhatsApp connection handler with memory-based session
async function connector(phoneNumber, res) {
    const sessionId = Date.now().toString(); // Unique ID for the session
    const virtualFiles = {}; // Stores session files in memory

    // Custom functions to mimic filesystem operations in memory
    const authState = {
        readFile: async (file) => virtualFiles[file] || null,
        writeFile: async (file, data) => { virtualFiles[file] = data; },
        removeFile: async (file) => { delete virtualFiles[file]; },
        fileExists: async (file) => virtualFiles[file] !== undefined,
        readDir: async () => Object.keys(virtualFiles),
        clear: async () => { Object.keys(virtualFiles).forEach(key => delete virtualFiles[key]); }
    };

    const { state, saveCreds } = await useMultiFileAuthState(authState);

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
                // Upload session files directly from memory
                const files = await authState.readDir();
                for (const file of files) {
                    const fileContent = await authState.readFile(file);
                    
                    // Upload to Vercel Blob
                    await put(`${sessionId}/${file}`, fileContent, {
                        access: 'public',
                        addRandomSuffix: false
                    });
                    
                    // Upload to Supabase
                    const { error } = await supabase.storage
                        .from('sessions')
                        .upload(`${sessionId}/${file}`, fileContent);
                    
                    if (error) throw error;
                }

                const fullSessionId = config.PREFIX + sessionId;
                await session.sendMessage(session.user.id, { 
                    text: `*Session ID*\n\n${fullSessionId}\n\n${config.MESSAGE}`
                });
                
                if (config.IMAGE) {
                    await session.sendMessage(session.user.id, { 
                        image: { url: config.IMAGE },
                        caption: `Session ID: ${fullSessionId}`
                    });
                }
            } catch (error) {
                console.error('Session handling error:', error);
            } finally {
                // Clear memory
                await authState.clear();
                if (session) session.end();
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