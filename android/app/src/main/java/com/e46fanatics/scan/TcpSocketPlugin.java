package com.e46fanatics.scan;

// TCP socket for Wi-Fi OBD adapters (ELM327 Wi-Fi at 192.168.0.10:35000, Deep OBD / esp-link at 192.168.4.1:23).
// The adapter's Wi-Fi has no internet, so Android would send the connection over mobile data:
// the socket is bound to the Wi-Fi network explicitly.

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;

@CapacitorPlugin(name = "TcpSocket")
public class TcpSocketPlugin extends Plugin {
    private Socket socket;
    private OutputStream out;
    private volatile boolean reading;

    private Network wifiNetwork() {
        ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return null;
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities c = cm.getNetworkCapabilities(n);
            if (c != null && c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return n;
        }
        return null;
    }

    @PluginMethod
    public void connect(PluginCall call) {
        final String host = call.getString("host", "192.168.0.10");
        final int port = call.getInt("port", 35000);
        final int timeout = call.getInt("timeout", 3000);
        closeSocket();
        new Thread(() -> {
            Socket s = new Socket();
            try {
                Network wifi = wifiNetwork();
                if (wifi != null) wifi.bindSocket(s);
                s.setTcpNoDelay(true);
                s.connect(new InetSocketAddress(host, port), timeout);
                socket = s;
                out = s.getOutputStream();
                startReader(s.getInputStream());
                JSObject r = new JSObject();
                r.put("wifi", wifi != null);
                call.resolve(r);
            } catch (Exception e) {
                try {
                    s.close();
                } catch (Exception ignored) {
                }
                call.reject("No adapter at " + host + ":" + port + " (" + e.getMessage() + ")");
            }
        }, "tcp-connect").start();
    }

    private void startReader(final InputStream in) {
        reading = true;
        new Thread(() -> {
            byte[] buf = new byte[1024];
            try {
                while (reading) {
                    int n = in.read(buf);
                    if (n < 0) break;
                    if (n == 0) continue;
                    JSObject o = new JSObject();
                    o.put("data", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP));
                    notifyListeners("data", o);
                }
            } catch (Exception ignored) {
            }
            if (reading) {
                reading = false;
                notifyListeners("closed", new JSObject());
            }
        }, "tcp-reader").start();
    }

    @PluginMethod
    public void write(PluginCall call) {
        try {
            if (out == null) throw new Exception("not connected");
            out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            out.flush();
            call.resolve();
        } catch (Exception e) {
            call.reject("Adapter disconnected");
        }
    }

    @PluginMethod
    public void close(PluginCall call) {
        closeSocket();
        call.resolve();
    }

    private synchronized void closeSocket() {
        reading = false;
        try {
            if (socket != null) socket.close();
        } catch (Exception ignored) {
        }
        socket = null;
        out = null;
    }

    @Override
    protected void handleOnDestroy() {
        closeSocket();
    }
}
