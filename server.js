const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const admin = require("firebase-admin");

// === Stripe ===
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// === MercadoPago ===
const mercadopago = require("mercadopago");
mercadopago.configure({ access_token: process.env.MP_ACCESS_TOKEN });

// === Firebase ===
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// =======================
// Endpoint de prueba: Stripe Checkout
// =======================
app.post("/stripe-checkout", async (req, res) => {
  try {
    const { priceId, email, uid } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://tuapp.com/success",
      cancel_url: "https://tuapp.com/cancel",
      customer_email: email,
    });

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error("Error Stripe:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// Endpoint de prueba: MercadoPago Checkout
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
        success: "https://tuapp.com/success",
        failure: "https://tuapp.com/failure",
        pending: "https://tuapp.com/pending",
      },
      auto_return: "approved",
    };

    const response = await mercadopago.preferences.create(preference);
    res.json({ init_point: response.body.init_point });
  } catch (err) {
    console.error("Error MercadoPago:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// Webhook Stripe (prueba)
// =======================
app.post("/webhook-stripe", bodyParser.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook Error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Manejo simple de suscripción pagada
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log("✅ Stripe checkout completado para:", session.customer_email);
    // Aquí podrías actualizar Firestore para marcar usuario activo
  }

  res.json({ received: true });
});

// =======================
// Puerto
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
