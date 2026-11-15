import SwiftUI
import ServiceManagement
import EavesCore

struct SettingsView: View {
    @ObservedObject private var settings = Settings.shared
    @ObservedObject var weather: WeatherController

    @State private var query = ""
    @State private var places: [Place] = []
    @State private var searching = false
    @State private var searchMessage = ""
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginMessage = ""

    init(weather: WeatherController) {
        _weather = ObservedObject(wrappedValue: weather)
    }

    var body: some View {
        Form {
            Section("Location") {
                LabeledContent("Following") {
                    Text(settings.hasLocation ? settings.locationName : "Nowhere yet")
                        .foregroundStyle(settings.hasLocation ? HierarchicalShapeStyle.primary : HierarchicalShapeStyle.secondary)
                }
                HStack {
                    TextField("City", text: $query, prompt: Text("Search for a city"))
                        .onSubmit(search)
                    Button(searching ? "Searching…" : "Search", action: search)
                        .disabled(searching || trimmedQuery.isEmpty)
                }
                ForEach(places) { place in
                    Button(place.label) { choose(place) }
                        .buttonStyle(.link)
                }
                if !searchMessage.isEmpty {
                    note(searchMessage)
                }
                Button("Use My Current Location") {
                    places = []
                    weather.locate()
                }
                if !weather.locationStatus.isEmpty {
                    note(weather.locationStatus)
                }
                if !weather.status.isEmpty {
                    note(weather.status)
                }
                note("Weather comes from Open-Meteo. Eaves sends it only the position of the place you "
                    + "follow, rounded to about a kilometre.")
            }

            Section("Weather") {
                Toggle("Follow the live weather", isOn: $settings.followWeather)
                Picker("Scene when not following", selection: $settings.manualScene) {
                    ForEach(SceneKind.allCases, id: \.rawValue) { scene in
                        Text(scene.title).tag(scene.rawValue)
                    }
                    Text("Nothing").tag("none")
                }
                Toggle("Seasonal scenes on dry days", isOn: $settings.ambience)
                Slider(value: $settings.density, in: 0.25...2) {
                    Text("Amount")
                }
                Slider(value: $settings.opacity, in: 0.2...1) {
                    Text("Opacity")
                }
                Picker("Temperature", selection: $settings.fahrenheit) {
                    Text("°C").tag(false)
                    Text("°F").tag(true)
                }
                .pickerStyle(.segmented)
                Toggle("Show the temperature in the menu bar", isOn: $settings.showTemperature)
            }

            Section("Windows") {
                Picker("Weather appears", selection: $settings.depthMode) {
                    ForEach(DepthMode.allCases, id: \.rawValue) { mode in
                        Text(mode.title).tag(mode.rawValue)
                    }
                }
                Toggle("Snow piles up on windows", isOn: $settings.pilesEnabled)
                Toggle("Hide while an app is full screen", isOn: $settings.hideInFullScreen)
                Toggle("Lightning flashes in thunderstorms", isOn: $settings.lightning)
                Toggle("Smooth animation (60 frames a second)", isOn: $settings.smooth)
            }

            Section("General") {
                Toggle("Open Eaves at login", isOn: Binding(get: { launchAtLogin }, set: setLaunchAtLogin))
                if !loginMessage.isEmpty {
                    note(loginMessage)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 480, height: 700)
    }

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func search() {
        let text = trimmedQuery
        guard !text.isEmpty, !searching else { return }
        searching = true
        searchMessage = ""
        weather.search(text) { result in
            searching = false
            switch result {
            case .success(let found):
                places = found
                searchMessage = found.isEmpty ? "No place found with that name." : ""
            case .failure(let error):
                places = []
                searchMessage = "The search did not work: \(error.localizedDescription)"
            }
        }
    }

    private func choose(_ place: Place) {
        settings.useCurrentLocation = false
        settings.setLocation(name: place.name, latitude: place.latitude, longitude: place.longitude)
        places = []
        query = ""
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            loginMessage = ""
        } catch {
            loginMessage = "macOS would not change this: \(error.localizedDescription) "
                + "Move Eaves to the Applications folder and try again."
        }
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }
}
