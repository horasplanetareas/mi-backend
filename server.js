const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const admin = require("firebase-admin");

// Stripe
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// MercadoPago (versión nueva)
const mercadopago = require("mercadopago");
mercadopago.configurations = { access_token: process.env.MP_ACCESS_TOKEN };

// Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// =======================
// Stripe Checkout
// =======================
app.post("/stripe-checkout", async (req, res) => {
  try {
    const { priceId, email, uid } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "http://localhost:4200/success",
      cancel_url: "http://localhost:4200/cancel",
      customer_email: email,
    });

    await db.collection("users").doc(uid).set({
      stripeSessionId: session.id,
      subscriptionActive: false,
    }, { merge: true });

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error("Error Stripe:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// MercadoPago Checkout
// =======================
app.post("/mp-checkout", async (req, res) => {
  try {
    const { uid } = req.body;

    const preference = {
      items: [
        {
          title: "Suscripción Mensual",
          unit_price: 300,
          quantity: 1,
        },
      ],
      back_urls: {
        success: "http://localhost:4200/success",
        failure: "http://localhost:4200/failure",
        pending: "http://localhost:4200/pending",
      },
      auto_return: "approved",
    };

    const response = await mercadopago.preferences.create(preference);

    await db.collection("users").doc(uid).set({
      mpPreferenceId: response.body.id,
      subscriptionActive: false,
    }, { merge: true });

    res.json({ init_point: response.body.init_point });
  } catch (err) {
    console.error("Error MercadoPago:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// Webhook Stripe
// =======================
app.post("/webhook-stripe", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook Error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log("✅ Stripe checkout completado:", session.customer_email);

    const userRef = db.collection("users").where("stripeSessionId", "==", session.id);
    const snapshot = await userRef.get();
    snapshot.forEach(doc => doc.ref.update({ subscriptionActive: true }));
  }

  res.json({ received: true });
});

// =======================
// Webhook MercadoPago
// =======================
app.post("/webhook-mp", async (req, res) => {
  const data = req.body;
  console.log("🔔 Webhook MP recibido:", data);

  if (data.type === "payment") {
    const preferenceId = data.data.preference_id;
    const userRef = db.collection("users").where("mpPreferenceId", "==", preferenceId);
    const snapshot = await userRef.get();
    snapshot.forEach(doc => doc.ref.update({ subscriptionActive: true }));
  }

  res.json({ received: true });
});

// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
