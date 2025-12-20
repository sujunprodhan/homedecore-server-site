require('dotenv').config();
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);

// Middleware
app.use(cors());
app.use(express.json());

function generateTrackingId() {
  return 'TRK-' + Math.random().toString(36).substring(2, 10).toUpperCase();
}

// MongoDB
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cruduser.c6e8c0q.mongodb.net/?appName=Cruduser`;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

async function run() {
  try {
    await client.connect();

    const db = client.db('homedb');
    const serviceCollection = db.collection('services');
    const homeCollection = db.collection('homeservice');
    const bookingCollection = db.collection('bookings');
    const paymentCollection = db.collection('payments');
    const userCollection = db.collection('users');
    const reviewCollection = db.collection('reviews'); // <-- Reviews collection

    /* ===================== USERS ===================== */
    app.post('/users', async (req, res) => {
      const user = req.body;
      const existing = await userCollection.findOne({ email: user.email });
      if (existing) return res.send({ message: 'User already exists' });

      const newUser = {
        name: user.name,
        email: user.email,
        photoURL: user.photoURL,
        role: 'user',
        createdAt: new Date(),
      };

      const result = await userCollection.insertOne(newUser);
      res.send(result);
    });

    app.get('/users', async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    app.get('/users/:email/role', async (req, res) => {
      const user = await userCollection.findOne({ email: req.params.email });
      res.send({ role: user?.role || 'user' });
    });

    app.patch('/users/admin/:id', async (req, res) => {
      const result = await userCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { role: 'admin' } }
      );
      res.send(result);
    });

    app.patch('/users/user/:id', async (req, res) => {
      try {
        const result = await userCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { role: 'user' } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: 'Failed to convert admin to user' });
      }
    });

    /* ===================== BOOKINGS ===================== */
    app.post('/bookings', async (req, res) => {
      const booking = { ...req.body, status: 'pending', createdAt: new Date() };
      const result = await bookingCollection.insertOne(booking);
      res.send(result);
    });

    app.get('/bookings', async (req, res) => {
      const email = req.query.email;
      const query = email ? { email } : {};
      const result = await bookingCollection.find(query).toArray();
      res.send(result);
    });

    app.get('/booking/:id', async (req, res) => {
      const result = await bookingCollection.findOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    });

    app.delete('/bookings/:id', async (req, res) => {
      const result = await bookingCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    });

    app.patch('/bookings/:id', async (req, res) => {
      const { bookingDate, location, assignedDecorator } = req.body;
      const id = req.params.id;

      const updateFields = {};
      if (bookingDate) updateFields.bookingDate = bookingDate;
      if (location) updateFields.location = location;
      if (assignedDecorator) updateFields.assignedDecorator = assignedDecorator;
      updateFields.updatedAt = new Date();

      const result = await bookingCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updateFields }
      );
      res.send(result);
    });

    /* ===================== ADMIN BOOKINGS ===================== */
    app.get('/admin/bookings', async (req, res) => {
      try {
        const bookings = await bookingCollection.find().toArray();
        const bookingsWithUserAndDecorator = await Promise.all(
          bookings.map(async (b) => {
            const user = await userCollection.findOne({ email: b.email });
            let decoratorName = '';
            if (b.assignedDecorator) {
              const decorator = await userCollection.findOne({ email: b.assignedDecorator });
              decoratorName = decorator?.name || '';
            }
            return {
              ...b,
              userName: user?.name || '',
              userEmail: user?.email || b.email,
              decoratorName,
            };
          })
        );
        res.send(bookingsWithUserAndDecorator);
      } catch (err) {
        res.status(500).send({ message: 'Failed to fetch bookings' });
      }
    });

    app.patch('/admin/bookings/:id', async (req, res) => {
      const { status, assignedDecorator } = req.body;
      const updateFields = {};
      if (status) updateFields.status = status;
      if (assignedDecorator) updateFields.assignedDecorator = assignedDecorator;

      const result = await bookingCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: updateFields }
      );
      res.send(result);
    });

    app.patch('/admin/bookings/paid/:id', async (req, res) => {
      const id = req.params.id;
      const result = await bookingCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: 'Paid', paidAt: new Date() } }
      );
      res.send(result);
    });

    /* ===================== STRIPE PAYMENT ===================== */
    app.post('/create-checkout-session', async (req, res) => {
      const { bookingId, bookingEmail, bookingName, cost } = req.body;
      const amount = parseInt(cost) * 100;

      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [
            {
              price_data: {
                currency: 'USD',
                unit_amount: amount,
                product_data: { name: bookingName },
              },
              quantity: 1,
            },
          ],
          mode: 'payment',
          customer_email: bookingEmail,
          metadata: { bookingId, bookingName },
          success_url: `${process.env.SITE_DOMIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMIN}/dashboard/payment-cancel`,
        });

        res.send({ url: session.url });
      } catch (error) {
        res.status(500).send({ message: 'Stripe session creation failed' });
      }
    });

    app.patch('/payments-success', async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        if (!sessionId) return res.status(400).send({ message: 'Session ID is required' });

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== 'paid') {
          return res.status(400).send({ success: false, message: 'Payment not completed' });
        }

        const transactionId = session.payment_intent;
        const trackingId = generateTrackingId();

        await bookingCollection.updateOne(
          { _id: new ObjectId(session.metadata.bookingId) },
          { $set: { status: 'Paid', trackingId } }
        );

        const payment = {
          price: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          bookingId: session.metadata.bookingId,
          serviceName: session.metadata.bookingName,
          transactionId,
          paymentStatus: session.payment_status,
          trackingId,
          paidAt: new Date(),
        };

        await paymentCollection.updateOne(
          { transactionId },
          { $setOnInsert: payment },
          { upsert: true }
        );

        res.send({
          success: true,
          transactionId,
          trackingId,
          price: payment.price,
          date: payment.paidAt,
          services: payment.serviceName,
        });
      } catch (error) {
        res.status(500).send({ success: false, message: 'Payment processing failed' });
      }
    });

    app.get('/payments', async (req, res) => {
      const email = req.query.email;
      const query = email ? { customerEmail: email } : {};
      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    /* ===================== SERVICES ===================== */
    app.get('/admin/services', async (req, res) => {
      const services = await serviceCollection.find().toArray();
      res.send(services);
    });

    app.post('/admin/services', async (req, res) => {
      const service = { ...req.body, createdAt: new Date() };
      const result = await serviceCollection.insertOne(service);
      res.send(result);
    });

    app.patch('/admin/services/:id', async (req, res) => {
      const result = await serviceCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: req.body }
      );
      res.send(result);
    });

    app.delete('/admin/services/:id', async (req, res) => {
      const result = await serviceCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    });

    /* ===================== HOME SERVICE ===================== */
    app.get('/homeservice', async (req, res) => {
      const result = await homeCollection.find().toArray();
      res.send(result);
    });

    app.get('/homeservice/:id', async (req, res) => {
      const result = await homeCollection.findOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    });

    /* ===================== DECORATORS ===================== */
    app.get('/admin/decorators', async (req, res) => {
      const decorators = await userCollection.find({ role: 'decorator' }).toArray();
      res.send(decorators);
    });

    app.post('/admin/decorators', async (req, res) => {
      const { name, email } = req.body;
      const existing = await userCollection.findOne({ email });
      if (existing) return res.status(400).send({ message: 'User already exists' });

      const newDecorator = {
        name,
        email,
        role: 'decorator',
        status: 'active',
        createdAt: new Date(),
      };

      const result = await userCollection.insertOne(newDecorator);
      res.send(result);
    });

    app.patch('/admin/decorators/:id', async (req, res) => {
      const { status } = req.body;
      const result = await userCollection.updateOne(
        { _id: new ObjectId(req.params.id), role: 'decorator' },
        { $set: { status } }
      );
      res.send(result);
    });

    app.delete('/admin/decorators/:id', async (req, res) => {
      const result = await userCollection.deleteOne({
        _id: new ObjectId(req.params.id),
        role: 'decorator',
      });
      res.send(result);
    });

    /* ===================== REVIEWS ===================== */
    // Add review
    app.post('/reviews', async (req, res) => {
      const { serviceId, userEmail, userName, rating, comment } = req.body;

      if (!serviceId || !userEmail || !rating) {
        return res.status(400).send({ message: 'Service, user and rating are required' });
      }

      const newReview = {
        serviceId: new ObjectId(serviceId),
        userEmail,
        userName,
        rating,
        comment: comment || '',
        createdAt: new Date(),
      };

      const result = await reviewCollection.insertOne(newReview);
      res.send(result);
    });

    // Get all reviews
    app.get('/reviews', async (req, res) => {
      const reviews = await reviewCollection.find().sort({ createdAt: -1 }).toArray();
      res.send(reviews);
    });

    // Get reviews for a specific service
    app.get('/reviews/service/:serviceId', async (req, res) => {
      const serviceId = req.params.serviceId;
      const reviews = await reviewCollection
        .find({ serviceId: new ObjectId(serviceId) })
        .sort({ createdAt: -1 })
        .toArray();
      res.send(reviews);
    });

    // Delete a review
    app.delete('/reviews/:id', async (req, res) => {
      const id = req.params.id;
      const result = await reviewCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    console.log('MongoDB connected successfully!');
  } finally {
    // client.close()
  }
}

run().catch(console.dir);

app.get('/', (req, res) => res.send('Server is running'));
app.listen(port, () => console.log(`Server running on port ${port}`));
