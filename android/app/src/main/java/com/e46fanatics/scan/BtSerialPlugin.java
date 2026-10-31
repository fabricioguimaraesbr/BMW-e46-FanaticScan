package com.e46fanatics.scan;

// Classic Bluetooth serial (SPP) for ELM327 adapters: most cheap "ELM327 v1.5" adapters are classic Bluetooth,
// which neither Web Bluetooth nor BLE can reach. The adapter is paired in Android's Bluetooth settings first;
// this plugin lists the paired devices, opens an RFCOMM socket and streams the bytes to the page.

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.InputStream;
import java.io.OutputStream;
import java.util.UUID;

@CapacitorPlugin(name = "BtSerial", permissions = { @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT }) })
public class BtSerialPlugin extends Plugin {
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    private BluetoothSocket socket;
    private OutputStream out;
    private Thread reader;
    private volatile boolean reading;

    private BluetoothAdapter adapter() {
        BluetoothManager m = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return m == null ? null : m.getAdapter();
    }

    private boolean needsPermission() {
        return Build.VERSION.SDK_INT >= 31 && getPermissionState("bluetooth") != PermissionState.GRANTED;
    }

    @PluginMethod
    public void listPaired(PluginCall call) {
        if (needsPermission()) {
            requestPermissionForAlias("bluetooth", call, "listAfterPermission");
            return;
        }
        doList(call);
    }

    @PermissionCallback
    private void listAfterPermission(PluginCall call) {
        if (needsPermission()) {
            call.reject("Bluetooth permission was not given");
            return;
        }
        doList(call);
    }

    @SuppressLint("MissingPermission")
    private void doList(PluginCall call) {
        BluetoothAdapter a = adapter();
        if (a == null) {
            call.reject("This phone has no Bluetooth");
            return;
        }
        if (!a.isEnabled()) {
            call.reject("Bluetooth is off: turn it on and try again");
            return;
        }
        JSArray arr = new JSArray();
        for (BluetoothDevice d : a.getBondedDevices()) {
            JSObject o = new JSObject();
            o.put("name", d.getName() == null ? d.getAddress() : d.getName());
            o.put("address", d.getAddress());
            o.put("type", d.getType()); // 1 classic, 2 LE, 3 dual
            arr.put(o);
        }
        JSObject r = new JSObject();
        r.put("devices", arr);
        call.resolve(r);
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void connect(PluginCall call) {
        if (needsPermission()) {
            call.reject("Bluetooth permission was not given");
            return;
        }
        String address = call.getString("address");
        BluetoothAdapter a = adapter();
        if (a == null || address == null) {
            call.reject("Adapter not found");
            return;
        }
        closeSocket();
        final BluetoothDevice d = a.getRemoteDevice(address);
        new Thread(() -> {
            BluetoothSocket s = null;
            try {
                a.cancelDiscovery();
                try {
                    s = d.createRfcommSocketToServiceRecord(SPP);
                    s.connect();
                } catch (Exception first) {
                    // some clones only accept the insecure socket
                    try {
                        if (s != null) s.close();
                    } catch (Exception ignored) {
                    }
                    s = d.createInsecureRfcommSocketToServiceRecord(SPP);
                    s.connect();
                }
                socket = s;
                out = s.getOutputStream();
                startReader(s.getInputStream());
                call.resolve();
            } catch (Exception e) {
                try {
                    if (s != null) s.close();
                } catch (Exception ignored) {
                }
                call.reject("Could not connect to the adapter: " + e.getMessage());
            }
        }, "bt-connect").start();
    }

    private void startReader(final InputStream in) {
        reading = true;
        reader = new Thread(() -> {
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
        }, "bt-reader");
        reader.start();
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
        reader = null;
    }

    @Override
    protected void handleOnDestroy() {
        closeSocket();
    }
}
