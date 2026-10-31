package com.e46fanatics.scan;

// Thin USB bridge for the FTDI chip of the K+DCAN / BMW Scanner cable.
// The Android WebView has no WebUSB, so the app's own FTDI driver (src/web/WebUsbFtdiChannel.ts) talks
// to the chip through this plugin: vendor control requests, bulk writes, and a reader thread that
// strips the two FTDI status bytes of each USB packet and pushes the data to the page.
// Nothing here knows about the car: every byte comes from the web code, where the read-only rules live.

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "UsbBridge")
public class UsbBridgePlugin extends Plugin {
    private static final int FTDI_VENDOR = 0x0403;
    private static final String ACTION_PERMISSION = "com.e46fanatics.scan.USB_PERMISSION";

    private UsbManager manager;
    private UsbDevice device;
    private UsbDeviceConnection conn;
    private UsbInterface intf;
    private UsbEndpoint epIn;
    private UsbEndpoint epOut;
    private Thread reader;
    private volatile boolean reading;
    private PluginCall pendingPermission;

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            UsbDevice d = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            if (ACTION_PERMISSION.equals(action)) {
                PluginCall call = pendingPermission;
                pendingPermission = null;
                if (call != null) {
                    JSObject r = new JSObject();
                    r.put("granted", intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false));
                    call.resolve(r);
                }
            } else if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action)) {
                if (d != null && d.getVendorId() == FTDI_VENDOR) notifyListeners("attached", describe(d));
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                if (d == null) return;
                if (device != null && d.getDeviceId() == device.getDeviceId()) closeDevice();
                if (d.getVendorId() == FTDI_VENDOR) notifyListeners("detached", describe(d));
            }
        }
    };

    @Override
    public void load() {
        manager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        IntentFilter f = new IntentFilter();
        f.addAction(ACTION_PERMISSION);
        f.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        f.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        ContextCompat.registerReceiver(getContext(), receiver, f, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        closeDevice();
        try {
            getContext().unregisterReceiver(receiver);
        } catch (Exception ignored) {
        }
    }

    private JSObject describe(UsbDevice d) {
        JSObject o = new JSObject();
        o.put("deviceId", d.getDeviceId());
        o.put("vendorId", d.getVendorId());
        o.put("productId", d.getProductId());
        o.put("productName", d.getProductName());
        o.put("hasPermission", manager.hasPermission(d));
        return o;
    }

    private UsbDevice find(int id) {
        for (UsbDevice d : manager.getDeviceList().values()) if (d.getDeviceId() == id) return d;
        return null;
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray arr = new JSArray();
        for (UsbDevice d : manager.getDeviceList().values()) if (d.getVendorId() == FTDI_VENDOR) arr.put(describe(d));
        JSObject r = new JSObject();
        r.put("devices", arr);
        call.resolve(r);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        UsbDevice d = find(call.getInt("deviceId", -1));
        if (d == null) {
            call.reject("Cable not found");
            return;
        }
        if (manager.hasPermission(d)) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        if (pendingPermission != null) pendingPermission.reject("Superseded");
        pendingPermission = call;
        Intent i = new Intent(ACTION_PERMISSION).setPackage(getContext().getPackageName());
        int flags = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
        manager.requestPermission(d, PendingIntent.getBroadcast(getContext(), 0, i, flags));
    }

    @PluginMethod
    public void open(PluginCall call) {
        UsbDevice d = find(call.getInt("deviceId", -1));
        if (d == null) {
            call.reject("Cable not found");
            return;
        }
        closeDevice();
        UsbDeviceConnection c = manager.openDevice(d);
        if (c == null) {
            call.reject("Android did not allow opening the cable");
            return;
        }
        UsbInterface ifc = d.getInterface(0);
        if (!c.claimInterface(ifc, true)) {
            c.close();
            call.reject("Could not claim the cable");
            return;
        }
        UsbEndpoint in = null, out = null;
        for (int k = 0; k < ifc.getEndpointCount(); k++) {
            UsbEndpoint e = ifc.getEndpoint(k);
            if (e.getType() != UsbConstants.USB_ENDPOINT_XFER_BULK) continue;
            if (e.getDirection() == UsbConstants.USB_DIR_IN) in = e;
            else out = e;
        }
        if (in == null || out == null) {
            c.releaseInterface(ifc);
            c.close();
            call.reject("Not a serial cable (no bulk endpoints)");
            return;
        }
        device = d;
        conn = c;
        intf = ifc;
        epIn = in;
        epOut = out;
        startReader();
        JSObject r = new JSObject();
        r.put("packetSize", in.getMaxPacketSize());
        call.resolve(r);
    }

    private void startReader() {
        reading = true;
        final UsbDeviceConnection c = conn;
        final UsbEndpoint in = epIn;
        final int ps = Math.max(8, in.getMaxPacketSize());
        reader = new Thread(() -> {
            byte[] buf = new byte[ps * 8];
            byte[] out = new byte[buf.length];
            while (reading) {
                int n = c.bulkTransfer(in, buf, buf.length, 50);
                if (n <= 2) continue; // timeout, or only the status bytes
                int m = 0;
                for (int p = 0; p < n; p += ps) {
                    int end = Math.min(p + ps, n);
                    for (int j = p + 2; j < end; j++) out[m++] = buf[j];
                }
                if (m == 0) continue;
                JSObject o = new JSObject();
                o.put("data", Base64.encodeToString(out, 0, m, Base64.NO_WRAP));
                notifyListeners("data", o);
            }
        }, "usb-reader");
        reader.start();
    }

    @PluginMethod
    public void control(PluginCall call) {
        if (conn == null) {
            call.reject("Cable not open");
            return;
        }
        int r = conn.controlTransfer(0x40, call.getInt("request", 0), call.getInt("value", 0), call.getInt("index", 0), null, 0, 1000);
        if (r < 0) {
            call.reject("USB control request failed");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void write(PluginCall call) {
        if (conn == null) {
            call.reject("Cable unplugged");
            return;
        }
        byte[] data = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
        int off = 0;
        while (off < data.length) {
            byte[] chunk = java.util.Arrays.copyOfRange(data, off, Math.min(data.length, off + 4096));
            int n = conn.bulkTransfer(epOut, chunk, chunk.length, 1000);
            if (n < 0) {
                call.reject("USB write failed");
                return;
            }
            off += n;
        }
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        closeDevice();
        call.resolve();
    }

    private synchronized void closeDevice() {
        reading = false;
        if (reader != null) {
            try {
                reader.join(300);
            } catch (InterruptedException ignored) {
            }
            reader = null;
        }
        if (conn != null) {
            try {
                conn.releaseInterface(intf);
            } catch (Exception ignored) {
            }
            conn.close();
        }
        conn = null;
        device = null;
        intf = null;
        epIn = epOut = null;
    }
}
