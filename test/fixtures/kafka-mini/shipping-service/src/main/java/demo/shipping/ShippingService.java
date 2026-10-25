package demo.shipping;

import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

@Service
public class ShippingService {
  private final RestClient carrier = RestClient.create();

  public String ship(OrderMessage message) {
    int attempts = 0;
    do {
      attempts++;
    } while (attempts < 3 && message.id() == null);
    return carrier.post().uri("https://carrier.example.com/labels").retrieve().body(String.class);
  }
}
