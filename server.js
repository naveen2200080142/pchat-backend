
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const AWS = require('aws-sdk');
const socketIo = require('socket.io');

const app = express();
const server = require('http').createServer(app);
const io = socketIo(server);

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'pchat_db_test',
  password: 'Naveen@13419', // Replace with your DB password
  port: 5433,
});

AWS.config.update({
  accessKeyId: '', // Replace with your AWS Access Key
  secretAccessKey: '', // Replace
  region: 'us-east-1',
});
const sns = new AWS.SNS();
const JWT_SECRET = 'Naveen@13419'; // Replace with secure secret
const onlineUsers = new Map(); // username -> socket
const messageQueue = new Map(); // username -> [messages]

app.use(express.json());

app.post('/api/send-otp', async (req, res) => {
  const { phone_number } = req.body;
  try {
    const userCheck = await pool.query(
      'SELECT id FROM users WHERE phone_number = $1',
      [phone_number]
    );
    let userId;
    if (userCheck.rows.length === 0) {
      const result = await pool.query(
        'INSERT INTO users (phone_number, username) VALUES ($1, $2) RETURNING id',
        [phone_number, phone_number]
      );
      userId = result.rows[0].id;
    } else {
      userId = userCheck.rows[0].id;
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    console.log('Sending OTP:', otp, 'to', phone_number);
    await pool.query(
      'INSERT INTO otps (user_id, otp) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET otp = $2',
      [userId, otp]
    );

    const params = {
      Message: `Your PCHAT OTP is: ${otp}`,
      PhoneNumber: phone_number,
    };

    await sns.publish(params).promise();
    res.status(200).json({ success: true, user_id: userId });
  } catch (error) {
    console.error('Error sending OTP:', error);
    res.status(400).json({ message: 'Failed to send OTP', error: error.message });
  }
});

app.post('/api/verify-otp', async (req, res) => {
  const { user_id, otp } = req.body;
  try {
    const result = await pool.query(
      'SELECT otp FROM otps WHERE user_id = $1',
      [user_id]
    );
    if (result.rows.length > 0 && result.rows[0].otp === otp) {
      await pool.query('DELETE FROM otps WHERE user_id = $1', [user_id]);
      res.json({ success: true });
    } else {
      res.status(401).json({ message: 'Invalid OTP' });
    }
  } catch (error) {
    console.error('OTP verification error:', error);
    res.status(400).json({ message: 'Verification failed', error: error.message });
  }
});

app.post('/api/register', async (req, res) => {
  const { user_id, username, public_key } = req.body;
  try {
    await pool.query(
      'UPDATE users SET username = $1, public_key = $2 WHERE id = $3',
      [username, public_key, user_id]
    );
    const token = jwt.sign({ id: user_id }, JWT_SECRET, { expiresIn: '30d' });
    await pool.query(
      'INSERT INTO user_tokens (user_id, token) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET token = $2',
      [user_id, token]
    );
    console.log('User registered:', username, 'Token:', token);
    res.status(201).json({ success: true, token });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(400).json({ message: 'Registration failed', error: error.message });
  }
});

app.post('/api/verify-token', async (req, res) => {
  const { token } = req.body;
  console.log('Verifying token:', token);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log('Decoded token:', decoded);
    const result = await pool.query(
      'SELECT token FROM user_tokens WHERE user_id = $1',
      [decoded.id]
    );
    console.log('DB token result:', result.rows);
    if (result.rows.length > 0 && result.rows[0].token === token) {
      res.json({ success: true, user: { id: decoded.id } });
    } else {
      res.status(401).json({ message: 'Invalid or expired token' });
    }
  } catch (error) {
    console.error('Token verification error:', error.message);
    res.status(401).json({ message: 'Token verification failed', error: error.message });
  }
});

app.post('/api/search-friend', async (req, res) => {
  const { phone_number } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  try {
    jwt.verify(token, JWT_SECRET);
    const result = await pool.query(
      'SELECT username, public_key FROM users WHERE phone_number = $1',
      [phone_number]
    );
    if (result.rows.length > 0) {
      const { username, public_key } = result.rows[0];
      const online_status = onlineUsers.has(username);
      res.json({ username, public_key, online_status });
    } else {
      res.status(404).json({ message: 'User not found' });
    }
  } catch (error) {
    console.error('Search friend error:', error);
    res.status(400).json({ message: 'Search failed', error: error.message });
  }
});

io.on('connection', (socket) => {
  console.log('Client connected');

  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const result = await pool.query(
        'SELECT u.username FROM users u JOIN user_tokens ut ON u.id = ut.user_id WHERE ut.token = $1',
        [token]
      );
      if (result.rows.length > 0) {
        const username = result.rows[0].username;
        socket.username = username;
        onlineUsers.set(username, socket);
        io.emit('status_update', { username, online_status: true });
        console.log('User authenticated:', username);

        if (messageQueue.has(username)) {
          const queuedMessages = messageQueue.get(username);
          queuedMessages.forEach((msg) => socket.emit('message', msg));
          messageQueue.delete(username);
          console.log('Sent queued messages to', username);
        }
      } else {
        socket.disconnect();
      }
    } catch (error) {
      console.error('Authentication failed:', error);
      socket.disconnect();
    }
  });

  socket.on('message', (data) => {
    const { to_username, encrypted_message, encrypted_aes_key } = data;
    const from_username = socket.username;
    const message = { from_username, encrypted_message, encrypted_aes_key };
    console.log('Message from', from_username, 'to', to_username);
    if (onlineUsers.has(to_username)) {
      onlineUsers.get(to_username).emit('message', message);
      console.log('Message sent to', to_username);
    } else {
      if (!messageQueue.has(to_username)) messageQueue.set(to_username, []);
      messageQueue.get(to_username).push(message);
      console.log('Message queued for', to_username);
    }
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      onlineUsers.delete(socket.username);
      io.emit('status_update', { username: socket.username, online_status: false });
      console.log('User disconnected:', socket.username);
    }
  });
});

server.listen(3000, () => console.log('Server running on port 3000'));