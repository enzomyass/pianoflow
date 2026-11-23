package com.rixon.pianoflow;

import android.content.Context;
import android.content.pm.PackageManager;
import android.media.midi.MidiDevice;
import android.media.midi.MidiDeviceInfo;
import android.media.midi.MidiManager;
import android.media.midi.MidiOutputPort;
import android.media.midi.MidiReceiver;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * USB (and any other system) MIDI input for the WebView, using android.media.midi.
 * Android WebView has no Web MIDI API, so raw MIDI bytes are forwarded to JS
 * as "midi" events ({ bytes: number[] }) and parsed there with running status.
 * Device list changes are sent as "devices" events ({ names: string[] }).
 */
@CapacitorPlugin(name = "UsbMidi")
public class UsbMidiPlugin extends Plugin {

    private MidiManager midiManager;
    private Handler handler;
    private Object deviceCallback; // MidiManager.DeviceCallback (API 23+)
    private final Map<Integer, MidiDevice> openDevices = new HashMap<>();
    private final Map<Integer, List<MidiOutputPort>> openPorts = new HashMap<>();
    private final Map<Integer, String> deviceNames = new HashMap<>();
    private boolean started = false;

    private boolean isSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_MIDI);
    }

    @PluginMethod
    public void start(PluginCall call) {
        JSObject result = new JSObject();
        if (!isSupported()) {
            result.put("supported", false);
            call.resolve(result);
            return;
        }
        if (!started) {
            startInternal();
        }
        result.put("supported", true);
        result.put("names", namesArray());
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopInternal();
        call.resolve();
    }

    @PluginMethod
    public void listDevices(PluginCall call) {
        JSObject result = new JSObject();
        result.put("names", namesArray());
        call.resolve(result);
    }

    private void startInternal() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        midiManager = (MidiManager) getContext().getSystemService(Context.MIDI_SERVICE);
        if (midiManager == null) return;
        handler = new Handler(Looper.getMainLooper());
        MidiManager.DeviceCallback cb = new MidiManager.DeviceCallback() {
            @Override
            public void onDeviceAdded(MidiDeviceInfo info) {
                openDevice(info);
            }

            @Override
            public void onDeviceRemoved(MidiDeviceInfo info) {
                closeDevice(info.getId());
                emitDevices();
            }
        };
        deviceCallback = cb;
        midiManager.registerDeviceCallback(cb, handler);
        MidiDeviceInfo[] infos = midiManager.getDevices();
        if (infos != null) {
            for (MidiDeviceInfo info : infos) {
                openDevice(info);
            }
        }
        started = true;
    }

    private void stopInternal() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        if (midiManager != null && deviceCallback != null) {
            midiManager.unregisterDeviceCallback((MidiManager.DeviceCallback) deviceCallback);
        }
        deviceCallback = null;
        List<Integer> ids = new ArrayList<>(openDevices.keySet());
        for (Integer id : ids) {
            closeDevice(id);
        }
        started = false;
    }

    private void openDevice(final MidiDeviceInfo info) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        if (info == null || info.getOutputPortCount() == 0) return; // nothing to read from
        final int id = info.getId();
        if (openDevices.containsKey(id)) return;
        midiManager.openDevice(info, new MidiManager.OnDeviceOpenedListener() {
            @Override
            public void onDeviceOpened(MidiDevice device) {
                if (device == null) return;
                List<MidiOutputPort> ports = new ArrayList<>();
                int count = info.getOutputPortCount();
                for (int i = 0; i < count; i++) {
                    MidiOutputPort port = device.openOutputPort(i);
                    if (port == null) continue;
                    port.connect(new MidiReceiver() {
                        @Override
                        public void onSend(byte[] msg, int offset, int len, long timestamp) {
                            forward(msg, offset, len);
                        }
                    });
                    ports.add(port);
                }
                openDevices.put(id, device);
                openPorts.put(id, ports);
                deviceNames.put(id, deviceName(info));
                emitDevices();
            }
        }, handler);
    }

    private void closeDevice(int id) {
        List<MidiOutputPort> ports = openPorts.remove(id);
        if (ports != null) {
            for (MidiOutputPort p : ports) {
                try {
                    p.close();
                } catch (IOException ignored) {
                }
            }
        }
        MidiDevice device = openDevices.remove(id);
        if (device != null) {
            try {
                device.close();
            } catch (IOException ignored) {
            }
        }
        deviceNames.remove(id);
    }

    private String deviceName(MidiDeviceInfo info) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return "MIDI device";
        Bundle props = info.getProperties();
        String name = props != null ? props.getString(MidiDeviceInfo.PROPERTY_NAME) : null;
        if (name == null || name.isEmpty()) {
            name = props != null ? props.getString(MidiDeviceInfo.PROPERTY_PRODUCT) : null;
        }
        return (name == null || name.isEmpty()) ? "MIDI device" : name;
    }

    private void forward(byte[] msg, int offset, int len) {
        JSArray bytes = new JSArray();
        for (int i = 0; i < len; i++) {
            bytes.put(msg[offset + i] & 0xFF);
        }
        JSObject data = new JSObject();
        data.put("bytes", bytes);
        notifyListeners("midi", data);
    }

    private JSArray namesArray() {
        JSArray names = new JSArray();
        for (String n : deviceNames.values()) {
            names.put(n);
        }
        return names;
    }

    private void emitDevices() {
        JSObject data = new JSObject();
        data.put("names", namesArray());
        notifyListeners("devices", data);
    }

    @Override
    protected void handleOnDestroy() {
        stopInternal();
        super.handleOnDestroy();
    }
}
